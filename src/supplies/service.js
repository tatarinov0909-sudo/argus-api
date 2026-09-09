const { HttpError } = require('../middleware/errorHandler');
const { formatBlockLabel } = require('../cells/label');
const journal = require('../journal/repository');

// Поставка: пачка заказов, уезжающая одной машиной.
//
// Три состояния и только вперёд: собирается → собрана → уехала. Назад пути
// нет намеренно. «Уехала» — событие в физическом мире: машина ушла, и отменить
// это в базе значит соврать. Ошиблись — заводится новая поставка, а старая
// остаётся в истории как есть.

const STATUS_NAMES = {
  collecting: 'собирается',
  ready: 'собрана, ждёт отгрузки',
  shipped: 'уехала',
};

// Номер поставки человеку, а не машине: дату видно глазами, счётчик внутри
// дня короткий. Его называют вслух по телефону и пишут на коробке, поэтому
// UUID здесь не годится.
// Номер занят? Значит рядом создали такую же поставку в ту же секунду —
// пересчитываем и пробуем снова. Считать и вставлять одним запросом нельзя:
// счётчик внутри дня, а не глобальная последовательность, и «предыдущий
// номер» приходится читать. Три попытки с запасом: одновременных нажатий
// на складе бывает два, не тридцать.
async function nextNumber(client, warehouseId) {
  const today = new Date();
  const stamp = `${String(today.getDate()).padStart(2, '0')}${String(today.getMonth() + 1).padStart(2, '0')}`;
  const r = await client.query(
    `SELECT count(*)::int AS n FROM supplies
      WHERE warehouse_id = $1 AND created_at::date = now()::date`,
    [warehouseId],
  );
  return `ПС-${stamp}-${String(r.rows[0].n + 1).padStart(2, '0')}`;
}

const UNIQUE_VIOLATION = '23505';

async function insertWithNumber(client, warehouseId, { companyId, marketplace, destination }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const number = await nextNumber(client, warehouseId);
    try {
      const r = await client.query(
        `INSERT INTO supplies (warehouse_id, company_id, number, marketplace, destination)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, number, status, destination, created_at`,
        [warehouseId, companyId, number, marketplace, destination],
      );
      return r.rows[0];
    } catch (err) {
      // Внутри транзакции неудачная вставка отравляет её целиком, поэтому
      // откатываемся к точке сохранения, а не пробуем «просто ещё раз».
      if (err.code !== UNIQUE_VIOLATION) throw err;
      await client.query('ROLLBACK TO SAVEPOINT supply_number').catch(() => {});
    }
  }
  throw new HttpError(409, 'Не удалось выдать номер поставки — попробуйте ещё раз');
}

// Сопоставлен ли товар заказа с номенклатурой склада. Ключ — тот же, что
// в уникальном индексе `products`: склад, продавец и артикул.
const MAPPED_SQL = `EXISTS (SELECT 1 FROM products p
                             WHERE p.warehouse_id = ii.warehouse_id
                               AND p.company_id = ii.company_id
                               AND p.sku = ii.sku)`;

// Заказ, который склад физически не соберёт: товара нет в номенклатуре, или
// у заказа с площадки нет номера отправления. Номер спрашиваем только
// у площадочных заказов — у накладной из 1С его не бывает и быть не должно,
// и требовать его значило бы запретить поставку по обычной накладной.
const UNPICKABLE_SQL = `NOT ${MAPPED_SQL}
   OR (i.source <> '1c' AND ii.mp_rid IS NULL)`;

// Собрать поставку из заказов.
//
// Заказы обязаны быть одной компании: поставка уезжает по документам одного
// продавца, и смешать двух — значит отдать чужой товар под чужой накладной.
async function create(client, warehouseId, { invoiceIds, marketplace = null, destination = null, actor }) {
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    throw new HttpError(400, 'Не указано ни одного заказа');
  }

  const orders = await client.query(
    `SELECT i.id, i.number, i.company_id, i.direction, i.status, i.supply_id, c.name AS company_name,
            (NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id)
             OR EXISTS (SELECT 1 FROM invoice_items ii
                         WHERE ii.invoice_id = i.id
                           AND (${UNPICKABLE_SQL}))) AS has_unpickable
       FROM invoices i JOIN companies c ON c.id = i.company_id
      WHERE i.warehouse_id = $1 AND i.id = ANY($2::uuid[])`,
    [warehouseId, invoiceIds],
  );
  if (orders.rows.length !== invoiceIds.length) {
    throw new HttpError(404, 'Часть заказов не найдена на этом складе');
  }

  const wrongDirection = orders.rows.find((o) => o.direction !== 'out');
  if (wrongDirection) {
    throw new HttpError(400, `«${wrongDirection.number}» — это не заказ на отгрузку`);
  }
  const alreadyIn = orders.rows.find((o) => o.supply_id);
  if (alreadyIn) {
    throw new HttpError(409, `«${alreadyIn.number}» уже в другой поставке`);
  }
  const companies = [...new Set(orders.rows.map((o) => o.company_id))];
  if (companies.length > 1) {
    throw new HttpError(400, 'В одной поставке заказы только одного продавца');
  }
  // Несобираемый заказ в поставку не берём — и решает это сервер, а не экран.
  // Экран уже фильтровал такие заказы и всё равно пропустил 36: он спрашивал
  // «есть ли строка с артикулом», а надо было «есть ли этот товар у нас».
  // Пока проверка живёт только в отрисовке, её обходит и устаревшая страница,
  // и прямой вызов, и любая следующая ошибка в том же условии.
  const unpickable = orders.rows.filter((o) => o.has_unpickable);
  if (unpickable.length > 0) {
    throw new HttpError(409,
      `${unpickable.length} ${unpickable.length === 1 ? 'заказ' : 'заказов'} нельзя собрать: `
      + 'товар не сопоставлен с номенклатурой склада или нет номера отправления. '
      + `Например «${unpickable[0].number}». Такие заказы остаются в очереди.`);
  }

  await client.query('SAVEPOINT supply_number');
  const supply = await insertWithNumber(client, warehouseId, {
    companyId: companies[0], marketplace, destination,
  });
  const number = supply.number;

  await client.query(
    `UPDATE invoices SET supply_id = $1 WHERE warehouse_id = $2 AND id = ANY($3::uuid[])`,
    [supply.id, warehouseId, invoiceIds],
  );

  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText: `Собрана поставка «${number}» — ${orders.rows.length} `
      + `${orders.rows.length === 1 ? 'заказ' : 'заказов'}, продавец «${orders.rows[0].company_name}».`,
    entityType: 'supply',
    entityId: supply.id,
    actorType: actor?.type || 'owner',
    actorId: actor?.id || null,
  });

  return { ...supply, orders: orders.rows.length, companyName: orders.rows[0].company_name };
}

// Состав поставки в том виде, в котором из него печатаются документы.
//
// Возвращаем и построчно, и сводно — это ДВА разных документа, и объединять
// их в один список нельзя: упаковщику нужна строка на каждое отправление со
// своим стикером, кладовщику — сумма по артикулу, чтобы идти за товаром один
// раз, а не столько раз, сколько заказов.
async function contents(client, warehouseId, supplyId) {
  const head = await client.query(
    `SELECT s.*, c.name AS company_name FROM supplies s
       JOIN companies c ON c.id = s.company_id
      WHERE s.warehouse_id = $1 AND s.id = $2`,
    [warehouseId, supplyId],
  );
  if (!head.rows[0]) throw new HttpError(404, 'Поставка не найдена');

  const lines = await client.query(
    `SELECT i.number AS order_number, ii.sku, ii.name, ii.declared_qty,
            ii.mp_rid, ii.mp_article, ii.mp_barcode, ii.mp_nm_id
       FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE i.warehouse_id = $1 AND i.supply_id = $2
      ORDER BY ii.name, i.number`,
    [warehouseId, supplyId],
  );

  const bySku = new Map();
  for (const l of lines.rows) {
    const key = l.sku;
    if (!bySku.has(key)) {
      bySku.set(key, {
        sku: l.sku, name: l.name, article: l.mp_article, barcode: l.mp_barcode,
        nmId: l.mp_nm_id, qty: 0,
        // `cells` — где лежит, `available` — сколько там годного. Второе нужно
        // отдельно: если в ячейках меньше, чем в поставке, узнать об этом надо
        // до похода к стеллажу, а не у стеллажа.
        cells: [], available: 0,
      });
    }
    bySku.get(key).qty += Number(l.declared_qty);
  }

  const packing = lines.rows.map((l) => ({
    orderNumber: l.order_number,
    sku: l.sku,
    name: l.name,
    article: l.mp_article,
    barcode: l.mp_barcode,
    nmId: l.mp_nm_id,
    rid: l.mp_rid,
    qty: Number(l.declared_qty),
  }));

  // Где это лежит. Без ячеек лист комплектации — это список покупок без
  // магазина: кладовщик знает, что взять, и не знает, куда идти.
  //
  // Только годное: брак лежит на тех же полках, и отправить его клиенту
  // вместо товара — худшее, что может сделать склад.
  const skus = [...bySku.keys()];
  const places = skus.length === 0 ? { rows: [] } : await client.query(
    `SELECT cs.sku, SUM(cs.qty) AS qty, wr.row_num, cb.label,
            cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       FROM cell_stock cs
       JOIN cell_blocks cb ON cb.id = cs.cell_block_id
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cs.warehouse_id = $1 AND cs.sku = ANY($2::text[])
        AND cs.qty > 0 AND cs.quality = 'good'
      GROUP BY cs.sku, cb.id, wr.row_num, cb.label,
               cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
      ORDER BY wr.row_num, cb.rack_start, cb.tier_start`,
    [warehouseId, skus],
  );
  for (const row of places.rows) {
    const item = bySku.get(row.sku);
    if (!item) continue;
    item.cells.push({
      label: formatBlockLabel(row.row_num, row),
      qty: Number(row.qty),
      rowNum: row.row_num,
      rack: row.rack_start,
      tier: row.tier_start,
    });
    item.available += Number(row.qty);
  }

  // Порядок обхода, а не алфавит.
  //
  // Лист комплектации существует ради одного: пройти склад один раз. По
  // алфавиту кладовщик мечется от первого ряда к седьмому и обратно; по
  // адресу — идёт вдоль стеллажей и собирает всё по дороге. Товар, которого
  // в ячейках нет, уходит в конец: за ним всё равно придётся идти отдельно
  // и разбираться.
  const picking = [...bySku.values()].sort((a, b) => {
    const A = a.cells[0];
    const B = b.cells[0];
    if (!A && !B) return a.name.localeCompare(b.name, 'ru');
    if (!A) return 1;
    if (!B) return -1;
    return A.rowNum - B.rowNum || A.rack - B.rack || A.tier - B.tier
      || a.name.localeCompare(b.name, 'ru');
  });

  return {
    supply: {
      id: head.rows[0].id,
      number: head.rows[0].number,
      status: head.rows[0].status,
      statusName: STATUS_NAMES[head.rows[0].status],
      marketplace: head.rows[0].marketplace,
      mpSupplyId: head.rows[0].mp_supply_id,
      destination: head.rows[0].destination,
      companyName: head.rows[0].company_name,
      createdAt: head.rows[0].created_at,
      readyAt: head.rows[0].ready_at,
      shippedAt: head.rows[0].shipped_at,
    },
    totals: {
      orders: new Set(lines.rows.map((l) => l.order_number)).size,
      units: packing.reduce((s, l) => s + l.qty, 0),
      uniqueSkus: picking.length,
    },
    // Что взять со склада: одинаковые товары объединены.
    picking,
    // Что положить в коробки: строка на каждое отправление.
    packing,
  };
}

const NEXT = { collecting: 'ready', ready: 'shipped' };

async function advance(client, warehouseId, supplyId, { to, destination = null, actor }) {
  const cur = await client.query(
    `SELECT id, number, status FROM supplies WHERE warehouse_id = $1 AND id = $2`,
    [warehouseId, supplyId],
  );
  if (!cur.rows[0]) throw new HttpError(404, 'Поставка не найдена');
  const from = cur.rows[0].status;

  if (NEXT[from] !== to) {
    throw new HttpError(409, from === 'shipped'
      ? 'Поставка уже уехала — назад её не вернуть, заведите новую'
      : `Из «${STATUS_NAMES[from]}» нельзя перейти в «${STATUS_NAMES[to] || to}»`);
  }

  // Собранной поставка становится только когда собран КАЖДЫЙ заказ в ней.
  //
  // Без этой проверки поставку можно было отгрузить, не сняв с полки ни одной
  // коробки: заказы получали «отгружено», продавец видел, что товар уехал,
  // а товар лежал в ячейке и продолжал числиться в остатке. Отдельная охрана
  // на отгрузке одного заказа (shipping/routes.js) при этом была — и поставка
  // её обходила, потому что писала статус напрямую.
  if (to === 'ready') {
    const notPicked = await client.query(
      `SELECT i.number, i.status FROM invoices i
        WHERE i.warehouse_id = $1 AND i.supply_id = $2 AND i.status <> 'ready'
        ORDER BY i.number LIMIT 3`,
      [warehouseId, supplyId],
    );
    if (notPicked.rows.length > 0) {
      const names = notPicked.rows.map((r) => `«${r.number}»`).join(', ');
      throw new HttpError(409,
        `Ещё не собрано: ${names}. Поставка считается собранной, когда собран каждый заказ в ней.`);
    }
    const empty = await client.query(
      `SELECT 1 FROM invoices WHERE warehouse_id = $1 AND supply_id = $2 LIMIT 1`,
      [warehouseId, supplyId],
    );
    if (empty.rows.length === 0) {
      throw new HttpError(409, 'В поставке нет ни одного заказа — собирать нечего');
    }
  }

  const stampColumn = to === 'ready' ? 'ready_at' : 'shipped_at';
  const updated = await client.query(
    `UPDATE supplies SET status = $3::supply_status, ${stampColumn} = now(),
            destination = COALESCE($4, destination)
      WHERE warehouse_id = $1 AND id = $2
      RETURNING id, number, status, destination, ready_at, shipped_at`,
    [warehouseId, supplyId, to, destination],
  );

  // Уехала — значит уехали и заказы в ней. Иначе продавец видел бы товар
  // на складе, которого там уже нет.
  if (to === 'shipped') {
    await client.query(
      `UPDATE invoices SET status = 'shipped' WHERE warehouse_id = $1 AND supply_id = $2`,
      [warehouseId, supplyId],
    );
  }

  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText: to === 'shipped'
      ? `Поставка «${cur.rows[0].number}» уехала${updated.rows[0].destination ? ` — ${updated.rows[0].destination}` : ''}.`
      : `Поставка «${cur.rows[0].number}» собрана, ждёт отгрузки.`,
    entityType: 'supply',
    entityId: supplyId,
    actorType: actor?.type || 'owner',
    actorId: actor?.id || null,
  });

  return { ...updated.rows[0], statusName: STATUS_NAMES[updated.rows[0].status] };
}

async function list(client, warehouseId, { status = null } = {}) {
  // Чужое значение отсекаем сами. Приведение к типу перечисления прямо
  // в запросе роняло его целиком, и человек получал «внутреннюю ошибку»
  // там, где должен получить «такого статуса нет».
  if (status !== null && !Object.prototype.hasOwnProperty.call(STATUS_NAMES, status)) {
    throw new HttpError(400,
      `Статус может быть только: ${Object.keys(STATUS_NAMES).join(', ')}`);
  }
  const r = await client.query(
    `SELECT s.id, s.number, s.status, s.destination, s.marketplace, s.mp_supply_id,
            s.created_at, s.ready_at, s.shipped_at, c.name AS company_name,
            count(i.id)::int AS orders
       FROM supplies s
       JOIN companies c ON c.id = s.company_id
       LEFT JOIN invoices i ON i.supply_id = s.id
      WHERE s.warehouse_id = $1 AND ($2::text IS NULL OR s.status = $2::supply_status)
      GROUP BY s.id, c.name
      ORDER BY s.created_at DESC`,
    [warehouseId, status],
  );
  return r.rows.map((x) => ({ ...x, statusName: STATUS_NAMES[x.status] }));
}

// Заказы, которые ещё никуда не уехали, — сгруппированные по продавцам.
//
// Главный экран менеджера начинается не со списка заказов, а со списка
// продавцов и числа накопившегося у каждого. Двести заказов подряд — это
// выгрузка базы, по ней нельзя решить, чем заняться; «у Slim Team набралось
// 153» — можно.
//
// Считается только то, что ещё не в поставке: попавшее в поставку уже решено
// и в этом списке лишнее.
async function pendingByCompany(client, warehouseId) {
  const r = await client.query(
    `SELECT c.id AS company_id, c.name AS company_name, i.source AS marketplace,
            count(DISTINCT i.id)::int AS orders,
            COALESCE(sum(ii.declared_qty), 0)::numeric AS units,
            min(i.created_at) AS oldest,
            count(DISTINCT i.id) FILTER (WHERE ${UNPICKABLE_SQL})::int AS incomplete
       FROM invoices i
       JOIN companies c ON c.id = i.company_id
       LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE i.warehouse_id = $1
        AND i.direction = 'out'
        AND i.supply_id IS NULL
        AND i.status <> 'shipped'
      GROUP BY c.id, c.name, i.source
      ORDER BY count(DISTINCT i.id) DESC, c.name`,
    [warehouseId],
  );
  return r.rows.map((x) => ({
    companyId: x.company_id,
    companyName: x.company_name,
    marketplace: x.marketplace,
    orders: x.orders,
    units: Number(x.units),
    oldest: x.oldest,
    // Заказы, у которых нет нашего артикула или номера отправления: собрать
    // их нельзя, и лучше сказать об этом до того, как менеджер нажмёт
    // «всё на сборку», а не после.
    incomplete: x.incomplete,
  }));
}

// Заказы одного продавца — то, что менеджер видит, выбрав его в списке.
async function pendingOrders(client, warehouseId, companyId) {
  const r = await client.query(
    `SELECT i.id, i.number, i.created_at, i.source AS marketplace, i.status,
            ii.sku, ii.name, ii.declared_qty, ii.mp_article, ii.mp_barcode,
            ii.mp_nm_id, ii.mp_rid,
            NOT (${UNPICKABLE_SQL}) AS pickable
       FROM invoices i
       LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE i.warehouse_id = $1
        AND i.company_id = $2
        AND i.direction = 'out'
        AND i.supply_id IS NULL
        AND i.status <> 'shipped'
      ORDER BY i.created_at DESC, i.number`,
    [warehouseId, companyId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    number: x.number,
    createdAt: x.created_at,
    marketplace: x.marketplace,
    status: x.status,
    sku: x.sku,
    name: x.name,
    qty: x.declared_qty === null ? null : Number(x.declared_qty),
    article: x.mp_article,
    barcode: x.mp_barcode,
    nmId: x.mp_nm_id,
    rid: x.mp_rid,
    // Собирать нечего, пока товар не сопоставлен с номенклатурой склада.
    //
    // Проверяется наличие товара в номенклатуре, а не наличие строки `sku`.
    // Строка есть всегда: у несопоставленного заказа туда кладётся артикул
    // площадки, чтобы заказ не потерялся. Из-за этого «готов» означало всего
    // лишь «есть номер отправления», и 36 несобираемых заказов уехали
    // в поставку вместе с остальными — кладовщик пошёл бы искать на полке
    // артикул, которого на складе нет.
    ready: Boolean(x.pickable),
  }));
}

// Разобрать поставку.
//
// Собрали не то — надо иметь возможность вернуть заказы в очередь. Разрешено
// только пока поставка «собирается»: после отбора товар уже снят с полок,
// а уехавшую поставку не разбирают в базе, её разгружают руками.
async function disband(client, warehouseId, supplyId, { actor }) {
  const s = await client.query(
    'SELECT id, number, status FROM supplies WHERE warehouse_id = $1 AND id = $2',
    [warehouseId, supplyId],
  );
  const supply = s.rows[0];
  if (!supply) throw new HttpError(404, 'Поставка не найдена');
  if (supply.status !== 'collecting') {
    throw new HttpError(409,
      `Поставка «${supply.number}» уже ${STATUS_NAMES[supply.status] || supply.status}`
      + ' — разобрать её в Аргусе нельзя.');
  }
  // Отобранное вернуть в очередь молча нельзя: товар уже снят с полки, и
  // «вернулось в очередь» означало бы, что его отберут второй раз.
  const picked = await client.query(
    `SELECT count(*)::int AS n FROM shipping_records sr
      JOIN invoice_items ii ON ii.id = sr.invoice_item_id
      JOIN invoices i ON i.id = ii.invoice_id
     WHERE i.supply_id = $1 AND sr.warehouse_id = $2`,
    [supplyId, warehouseId],
  );
  if (Number(picked.rows[0].n) > 0) {
    throw new HttpError(409,
      `По поставке «${supply.number}» уже отбирали товар — разобрать нельзя.`);
  }

  const freed = await client.query(
    'UPDATE invoices SET supply_id = NULL WHERE warehouse_id = $1 AND supply_id = $2',
    [warehouseId, supplyId],
  );
  await client.query('DELETE FROM supplies WHERE warehouse_id = $1 AND id = $2',
    [warehouseId, supplyId]);

  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText: `Поставка «${supply.number}» разобрана — ${freed.rowCount} `
      + `${freed.rowCount === 1 ? 'заказ' : 'заказов'} вернулись в очередь.`,
    entityType: 'supply',
    entityId: supplyId,
    actorType: actor?.type || 'owner',
    actorId: actor?.id || null,
  });
  return { number: supply.number, returned: freed.rowCount };
}

module.exports = {
  create, contents, advance, list, pendingByCompany, pendingOrders, disband, STATUS_NAMES,
};
