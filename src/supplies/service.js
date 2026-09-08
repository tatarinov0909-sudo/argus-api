const { HttpError } = require('../middleware/errorHandler');
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

// Собрать поставку из заказов.
//
// Заказы обязаны быть одной компании: поставка уезжает по документам одного
// продавца, и смешать двух — значит отдать чужой товар под чужой накладной.
async function create(client, warehouseId, { invoiceIds, marketplace = null, destination = null, actor }) {
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    throw new HttpError(400, 'Не указано ни одного заказа');
  }

  const orders = await client.query(
    `SELECT i.id, i.number, i.company_id, i.direction, i.status, i.supply_id, c.name AS company_name
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

  const picking = [...bySku.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));

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

module.exports = { create, contents, advance, list, STATUS_NAMES };
