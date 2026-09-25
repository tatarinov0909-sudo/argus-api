const { HttpError } = require('../middleware/errorHandler');
const { plural } = require('../journal/plural');
const { formatBlockLabel } = require('../cells/label');
const { refreshSupplyStatus, lockSupplyOfInvoice } = require('./state');
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

// Сегодня по Москве, ГГГГ-ММ-ДД: и дата отгрузки, и номер поставки считаются
// по дню склада, а не по часовому поясу сервера.
const moscowToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

// Номер поставки человеку, а не машине: дату видно глазами, счётчик внутри
// дня короткий. Его называют вслух по телефону и пишут на коробке, поэтому
// UUID здесь не годится.
// Номер занят? Значит рядом создали такую же поставку в ту же секунду —
// пересчитываем и пробуем снова. Считать и вставлять одним запросом нельзя:
// счётчик внутри дня, а не глобальная последовательность, и «предыдущий
// номер» приходится читать. Три попытки с запасом: одновременных нажатий
// на складе бывает два, не тридцать.
//
// Считаем не «сколько поставок сегодня», а «какой номер сегодня самый
// большой». Со счётчиком по количеству разобранная поставка освобождала
// число в середине дня: счётчик возвращался на уже занятый номер, все три
// попытки давали один и тот же, и менеджер до полуночи получал «не удалось
// выдать номер поставки».
//
// День берём по Москве — тот же день, что и у даты отгрузки. Раньше число
// в номере бралось из часового пояса процесса, а счётчик — из пояса базы:
// на UTC-сервере ночью по Москве это разные сутки.
async function nextNumber(client, warehouseId) {
  const stamp = moscowToday().slice(5).split('-').reverse().join('');
  const prefix = `ПС-${stamp}-`;
  const r = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(number, '^.*-', ''), '')::int), 0) AS last
       FROM supply_numbers
      WHERE warehouse_id = $1 AND number ~ ('^' || $2 || '[0-9]+$')`,
    [warehouseId, prefix],
  );
  return `${prefix}${String(Number(r.rows[0].last) + 1).padStart(2, '0')}`;
}

const UNIQUE_VIOLATION = '23505';

async function insertWithNumber(client, warehouseId, {
  companyId, marketplace, destination, shipDate, shippingPointId,
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const number = await nextNumber(client, warehouseId);
    try {
      // Номер занимаем в том же шаге: разобранная поставка удаляется, а её
      // номер остаётся занятым навсегда — по нему уже напечатан лист.
      await client.query(
        'INSERT INTO supply_numbers (warehouse_id, number) VALUES ($1, $2)',
        [warehouseId, number],
      );
      const r = await client.query(
        `INSERT INTO supplies (warehouse_id, company_id, number, marketplace, destination,
                               ship_date, mp_shipping_point_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, number, status, destination, to_char(ship_date, 'YYYY-MM-DD') AS ship_date,
                   mp_shipping_point_id, created_at`,
        [warehouseId, companyId, number, marketplace, destination, shipDate, shippingPointId],
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

// Заказ, который уже подтвердили в кабинете WB, минуя Аргус: для площадки он
// «на сборке», его собирают по её поставке. Взять его в поставку Аргуса —
// значит собрать один заказ дважды. Так в ПС-1409-01 попали шесть заказов,
// которых продавец не нашёл среди новых на WB.
const WB_CONFIRMED_SQL = `(i.source <> '1c' AND i.mp_supplier_status IS NOT NULL
   AND i.mp_supplier_status <> 'new')`;

// Собрать поставку из заказов.
//
// Заказы обязаны быть одной компании: поставка уезжает по документам одного
// продавца, и смешать двух — значит отдать чужой товар под чужой накладной.
// Точка доставки — свободный текст менеджера («СЦ Коледино», «Казань»).
// Пустое — «не указана»; не строка или роман вместо адреса — ошибка ввода.
function cleanDestination(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Точка доставки должна быть текстом');
  const text = value.trim();
  if (text.length > 120) throw new HttpError(400, 'Точка доставки длиннее 120 знаков');
  return text || null;
}

// Плановая дата отгрузки. Прошедшую WB не примет — отказываем сразу, а не
// когда машина уже у ворот.
function cleanShipDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  const d = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) {
    throw new HttpError(400, 'Дата отгрузки — в виде ГГГГ-ММ-ДД');
  }
  if (text < moscowToday()) throw new HttpError(400, 'Дата отгрузки уже прошла');
  return text;
}

function cleanShippingPoint(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Некорректный пункт отгрузки');
  return id;
}

async function create(client, warehouseId, {
  invoiceIds, marketplace = null, destination: rawDestination = null,
  shipDate: rawShipDate = null, shippingPointId: rawPoint = null, actor,
}) {
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    throw new HttpError(400, 'Не указано ни одного заказа');
  }
  const destination = cleanDestination(rawDestination);
  const shipDate = cleanShipDate(rawShipDate);
  const shippingPointId = cleanShippingPoint(rawPoint);

  const orders = await client.query(
    `SELECT i.id, i.number, i.company_id, i.direction, i.status, i.mp_closed_at, i.supply_id,
            i.source, i.external_id, c.name AS company_name,
            ${WB_CONFIRMED_SQL} AS wb_confirmed,
            (NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id)
             OR EXISTS (SELECT 1 FROM invoice_items ii
                         WHERE ii.invoice_id = i.id
                           AND (${UNPICKABLE_SQL}))) AS has_unpickable
       FROM invoices i JOIN companies c ON c.id = i.company_id AND c.archived_at IS NULL
      WHERE i.warehouse_id = $1 AND i.id = ANY($2::uuid[]) ORDER BY i.id FOR UPDATE OF i`,
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
  const closed = orders.rows.find((o) => o.mp_closed_at || o.status === 'shipped');
  if (closed) throw new HttpError(409, `«${closed.number}» уже закрыт. Его нельзя включить в новую поставку.`);
  if (alreadyIn) {
    throw new HttpError(409, `«${alreadyIn.number}» уже в другой поставке`);
  }
  const confirmed = orders.rows.find((o) => o.wb_confirmed);
  if (confirmed) {
    throw new HttpError(409, `«${confirmed.number}» уже подтверждён в кабинете WB — `
      + 'его собирают по поставке WB, второй раз собирать его не нужно.');
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
      `${unpickable.length} ${plural(unpickable.length, 'заказ', 'заказа', 'заказов')} нельзя собрать: `
      + 'товар не сопоставлен с номенклатурой склада или нет номера отправления. '
      + `Например «${unpickable[0].number}». Такие заказы остаются в очереди.`);
  }

  await client.query('SAVEPOINT supply_number');
  const supply = await insertWithNumber(client, warehouseId, {
    companyId: companies[0], marketplace, destination, shipDate, shippingPointId,
  });
  const number = supply.number;

  await client.query(
    `UPDATE invoices SET supply_id = $1 WHERE warehouse_id = $2 AND id = ANY($3::uuid[])`,
    [supply.id, warehouseId, invoiceIds],
  );
  // Заказ мог быть собран ДО того, как его включили в поставку (накладную из
  // 1С собирают и без поставки). Тогда новых отборов не будет, пересчитать
  // статус поставки станет некому, и она навсегда зависала в «собирается»:
  // ни «Уехала», ни «Разобрать» уже не нажимаются.
  await refreshSupplyStatus(client, warehouseId, supply.id);

  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    // «Собрана» в Аргусе значит «грузчики всё собрали», поэтому здесь
    // «составлена»: пока это только решение менеджера, что уезжает.
    actionText: `Составлена поставка «${number}» — ${orders.rows.length} `
      + `${plural(orders.rows.length, 'заказ', 'заказа', 'заказов')}, продавец «${orders.rows[0].company_name}».`,
    entityType: 'supply',
    entityId: supply.id,
    actorType: actor?.type || 'owner',
    actorId: actor?.id || null,
  });

  return {
    ...supply,
    companyId: companies[0],
    orders: orders.rows.length,
    companyName: orders.rows[0].company_name,
    // Что именно подтверждать на площадке: её номер заказа и наш документ.
    // Площадочные заказы отличаются от накладных 1С: у последних внешнего
    // номера нет и подтверждать там нечего.
    marketplaceOrders: orders.rows
      .filter((o) => o.source !== '1c' && o.external_id)
      .map((o) => ({ invoiceId: o.id, number: o.number, externalId: o.external_id })),
  };
}

// Состав поставки в том виде, в котором из него печатаются документы.
//
// Возвращаем и построчно, и сводно — это ДВА разных документа, и объединять
// их в один список нельзя: упаковщику нужна строка на каждое отправление со
// своим стикером, кладовщику — сумма по артикулу, чтобы идти за товаром один
// раз, а не столько раз, сколько заказов.
async function contents(client, warehouseId, supplyId, { showShortages = false } = {}) {
  const head = await client.query(
    `SELECT s.*, to_char(s.ship_date, 'YYYY-MM-DD') AS ship_day, c.name AS company_name FROM supplies s
       JOIN companies c ON c.id = s.company_id AND c.archived_at IS NULL
      WHERE s.warehouse_id = $1 AND s.id = $2`,
    [warehouseId, supplyId],
  );
  if (!head.rows[0]) throw new HttpError(404, 'Поставка не найдена');
  // Закрытых на WB заказов в поставке нет: обмен убирает их из неё в той же
  // транзакции, где закрывает (marketplaces/statuses.js). Печать поэтому
  // больше не останавливается из-за одного заказа.

  const lines = await client.query(
    `SELECT i.number AS order_number, ii.id AS item_id, ii.sku, ii.name, ii.declared_qty,
            ii.mp_rid, ii.mp_article, ii.mp_barcode, ii.mp_nm_id,
            m.photo_url, st.part_a AS sticker_head, st.part_b AS sticker_tail,
            -- Сколько по строке уже снято с полки и закрыта ли она. Лист
            -- печатают не один раз: после перерыва в работе бумага, где
            -- «взять» стоит полное количество, отправляет кладовщика за
            -- товаром, который уже лежит на столе, и пишет «не хватает».
            COALESCE((SELECT SUM(sr.picked_qty) FROM shipping_records sr
                       WHERE sr.invoice_item_id = ii.id), 0) AS picked,
            EXISTS (SELECT 1 FROM shipping_records sr2
                     WHERE sr2.invoice_item_id = ii.id AND sr2.is_final) AS picked_closed,
            -- Грузчик отметил «нет товара», руководитель ещё не решил: при
            -- сборке по товару к этой позиции не возвращаемся.
            EXISTS (SELECT 1 FROM journal_entries je
                     WHERE je.warehouse_id = ii.warehouse_id AND je.urgent AND je.status = 'pending'
                       AND je.entity_type = 'invoice_item' AND je.entity_id = ii.id
                       AND NOT EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id)) AS missing_marked
       FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
       -- Фото товара с площадки: по нему кладовщик узнаёт товар на полке
       -- быстрее, чем по названию. Нет фото — колонки на листе просто нет.
       LEFT JOIN LATERAL (SELECT pm.photo_url FROM marketplace_product_media pm
                           WHERE pm.company_id = ii.company_id AND pm.nm_id = ii.mp_nm_id
                             AND pm.photo_url IS NOT NULL LIMIT 1) m ON true
       -- Номер стикера: по нему упаковщик кладёт в коробку ту этикетку,
       -- что от этого отправления, а не соседнюю.
       LEFT JOIN marketplace_order_stickers st ON st.invoice_id = i.id
      WHERE i.warehouse_id = $1 AND i.supply_id = $2
      ORDER BY ii.name, i.number`,
    [warehouseId, supplyId],
  );

  const remainingOf = (l) => (l.picked_closed
    ? 0
    : Math.max(0, Number(l.declared_qty) - Number(l.picked)));

  const bySku = new Map();
  for (const l of lines.rows) {
    const key = l.sku;
    if (!bySku.has(key)) {
      bySku.set(key, {
        sku: l.sku, name: l.name, article: l.mp_article, barcode: l.mp_barcode,
        nmId: l.mp_nm_id, photo: l.photo_url || null, qty: 0, total: 0, picked: 0,
        // `cells` — где лежит, `available` — сколько там годного. Второе нужно
        // отдельно: если в ячейках меньше, чем в поставке, узнать об этом надо
        // до похода к стеллажу, а не у стеллажа.
        cells: [], available: 0,
      });
    }
    const item = bySku.get(key);
    // `qty` — сколько ещё взять со склада, `total` — сколько всего в поставке.
    item.qty += remainingOf(l);
    item.total += Number(l.declared_qty);
    item.picked += Math.min(Number(l.picked), Number(l.declared_qty));
  }
  // Полностью собранные позиции на листе комплектации не нужны: за ними
  // больше не идут. В упаковочном листе они остаются — там считают коробки.
  for (const [key, item] of bySku) if (item.qty <= 0) bySku.delete(key);

  const packing = lines.rows.map((l) => ({
    orderNumber: l.order_number,
    // Для сборки по товару: какая это позиция и сколько по ней осталось.
    itemId: l.item_id,
    left: remainingOf(l),
    missing: l.missing_marked,
    sku: l.sku,
    name: l.name,
    article: l.mp_article,
    barcode: l.mp_barcode,
    nmId: l.mp_nm_id,
    photo: l.photo_url || null,
    rid: l.mp_rid,
    // Номер стикера WB — две части, как на самой этикетке: мелкая сверху
    // (5815412) и крупная снизу (5865). По ним сверяют посылку с этикеткой.
    stickerHead: l.sticker_head || null,
    stickerTail: l.sticker_tail || null,
    qty: Number(l.declared_qty),
  }));

  // Где это лежит. Без ячеек лист комплектации — это список покупок без
  // магазина: кладовщик знает, что взять, и не знает, куда идти.
  //
  // Только годное: брак лежит на тех же полках, и отправить его клиенту
  // вместо товара — худшее, что может сделать склад. И только этого
  // продавца: одинаковый артикул у двух продавцов — два разных товара,
  // и лист не должен посылать к полке с чужим.
  const skus = [...bySku.keys()];
  const places = skus.length === 0 ? { rows: [] } : await client.query(
    `SELECT cs.sku, SUM(cs.qty) AS qty, wr.row_num, cb.label,
            cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       FROM cell_stock cs
       JOIN cell_blocks cb ON cb.id = cs.cell_block_id
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cs.warehouse_id = $1 AND cs.company_id = $3 AND cs.sku = ANY($2::text[])
        AND cs.qty > 0 AND cs.quality = 'good'
      GROUP BY cs.sku, cb.id, wr.row_num, cb.label,
               cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
      ORDER BY wr.row_num, cb.rack_start, cb.tier_start`,
    [warehouseId, skus, head.rows[0].company_id],
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

  // Сколько брать из каждой ячейки — тем же правилом, что и в листе грузчика:
  // сколько есть в первой по обходу, остаток во второй. Без этого на бумаге
  // стоял один адрес и общее количество, а товар лежал в трёх местах.
  for (const item of bySku.values()) {
    let left = item.qty;
    for (const cell of item.cells) {
      cell.take = Math.max(0, Math.min(left, cell.qty));
      left -= cell.take;
    }
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

  // Этикетки заказов и QR поставки: их печатают перед отправкой, без них
  // посылки не принимают. Получены при передаче поставки на площадку.
  const stickers = await client.query(
    `SELECT i.number AS order_number, st.part_a, st.part_b, st.barcode, st.file,
            (SELECT ii.mp_rid FROM invoice_items ii
              WHERE ii.invoice_id = i.id AND ii.mp_rid IS NOT NULL LIMIT 1) AS mp_rid
       FROM invoices i
       JOIN marketplace_order_stickers st ON st.invoice_id = i.id
      WHERE i.warehouse_id = $1 AND i.supply_id = $2
      ORDER BY i.number`,
    [warehouseId, supplyId],
  );

  // Отметки грузчиков «нет товара» — видны в самой поставке, пока не решены.
  const shortages = !showShortages ? { rows: [] } : await client.query(
    `SELECT je.id, je.action_text, je.created_at, i.number AS order_number, i.id AS invoice_id,
            -- Убрать из поставки можно только заказ, по которому ничего не
            -- отобрано (см. removeOrder) — экран знает это заранее.
            EXISTS (SELECT 1 FROM shipping_records sr JOIN invoice_items ii ON ii.id = sr.invoice_item_id
                     WHERE ii.invoice_id = i.id AND sr.picked_qty > 0) AS order_picked
       FROM journal_entries je
       JOIN invoices i ON i.id = je.invoice_id
      WHERE je.warehouse_id = $1 AND i.supply_id = $2
        AND je.urgent AND je.status = 'pending' AND je.entity_type = 'invoice_item'
        AND NOT EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id)
      ORDER BY je.created_at DESC`,
    [warehouseId, supplyId],
  );

  return {
    shortages: shortages.rows.map((x) => ({
      entryId: x.id, text: x.action_text, at: x.created_at, orderNumber: x.order_number,
      invoiceId: x.invoice_id, orderPicked: x.order_picked,
    })),
    supply: {
      id: head.rows[0].id,
      number: head.rows[0].number,
      status: head.rows[0].status,
      statusName: STATUS_NAMES[head.rows[0].status],
      marketplace: head.rows[0].marketplace,
      mpSupplyId: head.rows[0].mp_supply_id,
      mpHandedAt: head.rows[0].mp_handed_at,
      mpDeliveredAt: head.rows[0].mp_delivered_at,
      mpBarcode: head.rows[0].mp_barcode,
      mpBarcodeFile: head.rows[0].mp_barcode_file,
      destination: head.rows[0].destination,
      shipDate: head.rows[0].ship_day,
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
    // Этикетки площадки на каждый заказ — печатаются с упаковочным листом.
    stickers: stickers.rows.map((s) => ({
      orderNumber: s.order_number,
      rid: s.mp_rid,
      partA: s.part_a,
      partB: s.part_b,
      barcode: s.barcode,
      file: s.file,
    })),
  };
}

// Поставка уехала: машина ушла, и вместе с ней все заказы поставки.
//
// «Собрана» ставится само, когда собран последний заказ (state.js), —
// отдельной кнопки для неё нет. Уехать может только собранная поставка:
// иначе заказы получили бы «отгружено», а товар остался бы на полке
// и продолжал числиться в остатке.
async function ship(client, warehouseId, supplyId, { destination: rawDestination = null, actor }) {
  const destination = cleanDestination(rawDestination);
  const cur = await client.query(
    `SELECT id, number, status, company_id, mp_supply_id, to_char(ship_date, 'YYYY-MM-DD') AS ship_date,
            mp_shipping_point_id, mp_shipping_set_at
       FROM supplies WHERE warehouse_id = $1 AND id = $2 FOR UPDATE`,
    [warehouseId, supplyId],
  );
  if (!cur.rows[0]) throw new HttpError(404, 'Поставка не найдена');
  const from = cur.rows[0].status;

  // Synchronization and picking lock these same rows. A cancellation cannot
  // slip between checking a supply and marking its orders as shipped.
  const orderLocks = await client.query(`SELECT id, number, status, mp_closed_at FROM invoices
    WHERE warehouse_id=$1 AND supply_id=$2 ORDER BY id FOR UPDATE`, [warehouseId, supplyId]);
  const ended = orderLocks.rows.find(o => o.mp_closed_at);
  if (ended) throw new HttpError(409, `Заказ «${ended.number}» закрыт на WB. Руководитель должен разобрать его в сверке заказов WB.`);

  if (from === 'shipped') throw new HttpError(409, 'Поставка уже уехала — назад её не вернуть, заведите новую');
  if (orderLocks.rows.length === 0) throw new HttpError(409, 'В поставке нет ни одного заказа — отгружать нечего');
  const notPicked = orderLocks.rows.filter(o => o.status !== 'ready');
  if (from !== 'ready' || notPicked.length > 0) {
    const names = notPicked.slice(0, 3).map(o => `«${o.number}»`).join(', ');
    throw new HttpError(409, `Ещё не собрано: ${names}. Уехать может только поставка, в которой собран каждый заказ.`);
  }

  const updated = await client.query(
    `UPDATE supplies SET status = 'shipped', shipped_at = now(), destination = COALESCE($3, destination)
      WHERE warehouse_id = $1 AND id = $2
      RETURNING id, number, status, destination, ready_at, shipped_at`,
    [warehouseId, supplyId, destination],
  );

  // Уехала — значит уехали и заказы в ней. Иначе продавец видел бы товар
  // на складе, которого там уже нет.
  await client.query(
    `UPDATE invoices i SET status='shipped', shipped_at=COALESCE(i.shipped_at,s.shipped_at)
     FROM supplies s WHERE i.warehouse_id=$1 AND i.supply_id=$2
       AND s.id=i.supply_id AND s.company_id=i.company_id`,
    [warehouseId, supplyId],
  );

  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText: `Поставка «${cur.rows[0].number}» уехала${updated.rows[0].destination ? ` — ${updated.rows[0].destination}` : ''}.`,
    entityType: 'supply',
    entityId: supplyId,
    actorType: actor?.type || 'owner',
    actorId: actor?.id || null,
  });

  return {
    ...updated.rows[0],
    statusName: STATUS_NAMES[updated.rows[0].status],
    companyId: cur.rows[0].company_id,
    mp_supply_id: cur.rows[0].mp_supply_id,
    ship_date: cur.rows[0].ship_date,
    mp_shipping_point_id: cur.rows[0].mp_shipping_point_id,
    mp_shipping_set_at: cur.rows[0].mp_shipping_set_at,
  };
}

// Хватит ли товара на полках — видно сразу, при составлении поставки, а не
// когда грузчик дошёл до пустой ячейки (решение владельца 24.09.2026).
//
// Годное в ячейках раздаём по очереди: сперва поставкам, которые уже
// собираются (старшие первыми), потом заказам в очереди (старшие первыми).
// Заказ, которому не хватило, помечен. Это оценка по учёту Аргуса: если на
// полке лежит не то, что в учёте, отметка это не поймает.
// Сколько по позиции ещё снимать с полки: заказано минус собрано, а у
// закрытой позиции — ноль. Закрывают и с нехваткой («взяли 3 из 5»), и
// собранное уже не на полке: иначе и то и другое «съедало» остаток дважды,
// и склад видел ложное «не хватит товара» (проверка 25.09.2026).
const LEFT_TO_PICK_SQL = `CASE WHEN EXISTS (SELECT 1 FROM shipping_records sr
                                         WHERE sr.invoice_item_id = ii.id AND sr.is_final) THEN 0
     ELSE ii.declared_qty - COALESCE((SELECT SUM(sr.picked_qty) FROM shipping_records sr
                                       WHERE sr.invoice_item_id = ii.id), 0) END`;

async function stockCover(client, warehouseId, companyId = null) {
  const stock = new Map();
  const cells = await client.query(
    `SELECT company_id, sku, SUM(qty)::numeric AS qty FROM cell_stock
      WHERE warehouse_id = $1 AND quality = 'good' AND qty > 0
        AND ($2::uuid IS NULL OR company_id = $2::uuid)
      GROUP BY company_id, sku`,
    [warehouseId, companyId],
  );
  for (const r of cells.rows) stock.set(`${r.company_id}|${r.sku}`, Number(r.qty));
  const demand = await client.query(
    `SELECT s.id AS supply_id, i.id AS invoice_id, i.company_id, ii.sku,
            ${LEFT_TO_PICK_SQL} AS need
       FROM supplies s
       JOIN invoices i ON i.supply_id = s.id
       JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE s.warehouse_id = $1 AND s.status = 'collecting'
        AND ($2::uuid IS NULL OR i.company_id = $2::uuid)
      ORDER BY s.created_at, i.number`,
    [warehouseId, companyId],
  );
  const shortInvoices = new Set();
  const take = (key, need) => {
    const left = stock.get(key) || 0;
    if (need <= 0) return true;
    if (left < need) { stock.set(key, 0); return false; }
    stock.set(key, left - need);
    return true;
  };
  for (const r of demand.rows) {
    if (!take(`${r.company_id}|${r.sku}`, Number(r.need))) shortInvoices.add(r.invoice_id);
  }
  return { shortInvoices, take };
}

async function list(client, warehouseId, { status = null, showShortages = false } = {}) {
  // Чужое значение отсекаем сами. Приведение к типу перечисления прямо
  // в запросе роняло его целиком, и человек получал «внутреннюю ошибку»
  // там, где должен получить «такого статуса нет».
  if (status !== null && !Object.prototype.hasOwnProperty.call(STATUS_NAMES, status)) {
    throw new HttpError(400,
      `Статус может быть только: ${Object.keys(STATUS_NAMES).join(', ')}`);
  }
  const r = await client.query(
    `SELECT s.id, s.number, s.status, s.destination, to_char(s.ship_date, 'YYYY-MM-DD') AS ship_date,
            s.marketplace, s.mp_supply_id,
            s.mp_handed_at, s.mp_delivered_at, s.mp_barcode,
            s.created_at, s.ready_at, s.shipped_at, c.name AS company_name,
            -- Кто составил: первая запись журнала о поставке. «Когда пришла»
            -- на склад — created_at.
            cb.actor_type AS created_by_role, cb.actor_name AS created_by,
            count(i.id)::int AS orders,
            count(i.id) FILTER (WHERE i.status IN ('ready', 'shipped'))::int AS picked,
            -- Сколько по поставке отмечено «нет товара» и ещё не решено.
            CASE WHEN $3::boolean THEN (
              SELECT count(*)::int FROM journal_entries je JOIN invoices i3 ON i3.id = je.invoice_id
               WHERE i3.supply_id = s.id AND je.urgent AND je.status = 'pending'
                 AND je.entity_type = 'invoice_item'
                 AND NOT EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id)) END AS missing
       FROM supplies s
       JOIN companies c ON c.id = s.company_id AND c.archived_at IS NULL
       LEFT JOIN LATERAL (
         SELECT je.actor_type,
                CASE WHEN je.actor_type = 'owner' THEN 'владелец' ELSE sk.name END AS actor_name
           FROM journal_entries je
           LEFT JOIN staff_keys sk ON sk.id = je.actor_id
          WHERE je.warehouse_id = s.warehouse_id AND je.entity_type = 'supply' AND je.entity_id = s.id
          ORDER BY je.created_at LIMIT 1) cb ON true
       LEFT JOIN invoices i ON i.supply_id = s.id
      WHERE s.warehouse_id = $1 AND ($2::text IS NULL OR s.status = $2::supply_status)
      GROUP BY s.id, c.name, cb.actor_type, cb.actor_name
      ORDER BY s.created_at DESC`,
    [warehouseId, status, showShortages === true],
  );
  // Сколько заказов поставки, по учёту, собрать не из чего.
  const { shortInvoices } = await stockCover(client, warehouseId);
  const shortBySupply = new Map();
  if (shortInvoices.size) {
    const owners = await client.query(
      'SELECT id, supply_id FROM invoices WHERE id = ANY($1::uuid[])', [[...shortInvoices]]);
    for (const o of owners.rows) shortBySupply.set(o.supply_id, (shortBySupply.get(o.supply_id) || 0) + 1);
  }
  return r.rows.map((x) => ({
    ...x, statusName: STATUS_NAMES[x.status],
    stockShort: x.status === 'collecting' ? (shortBySupply.get(x.id) || 0) : 0,
  }));
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
    `SELECT c.id AS company_id, c.name AS company_name,
            array_agg(DISTINCT i.source) AS sources,
            count(DISTINCT i.id) FILTER (WHERE NOT ${WB_CONFIRMED_SQL})::int AS orders,
            COALESCE(sum(ii.declared_qty) FILTER (WHERE NOT ${WB_CONFIRMED_SQL}), 0)::numeric AS units,
            min(COALESCE(i.mp_created_at, i.created_at)) FILTER (WHERE NOT ${WB_CONFIRMED_SQL}) AS oldest,
            count(DISTINCT i.id) FILTER (WHERE NOT ${WB_CONFIRMED_SQL} AND (${UNPICKABLE_SQL}))::int AS incomplete,
            count(DISTINCT i.id) FILTER (WHERE ${WB_CONFIRMED_SQL})::int AS wb_confirmed
       FROM invoices i
       JOIN companies c ON c.id = i.company_id AND c.archived_at IS NULL
       LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE i.warehouse_id = $1
        AND i.direction = 'out'
        AND i.supply_id IS NULL
        AND i.status <> 'shipped'
        AND i.mp_closed_at IS NULL
      GROUP BY c.id, c.name
      ORDER BY count(DISTINCT i.id) DESC, c.name`,
    [warehouseId],
  );
  return r.rows.map((x) => ({
    companyId: x.company_id,
    companyName: x.company_name,
    // Продавец — одна карточка, даже если заказы пришли и с площадки, и из 1С:
    // раньше он шёл двумя строками, и менеджер составлял две поставки там,
    // где нужна одна. Площадка карточки — WB, если среди заказов есть WB.
    marketplaces: x.sources || [],
    marketplace: (x.sources || []).includes('wb') ? 'wb' : (x.sources || [])[0] || null,
    orders: x.orders,
    units: Number(x.units),
    oldest: x.oldest,
    // Заказы, у которых нет нашего артикула или номера отправления: собрать
    // их нельзя, и лучше сказать об этом до того, как менеджер нажмёт
    // «всё на сборку», а не после.
    incomplete: x.incomplete,
    // Уже подтверждённые в кабинете WB: в число новых не входят.
    wbConfirmed: x.wb_confirmed,
  }));
}

// Заказы одного продавца — то, что менеджер видит, выбрав его в списке.
async function pendingOrders(client, warehouseId, companyId) {
  const r = await client.query(
    `SELECT i.id, i.number, i.created_at, i.source AS marketplace, i.status,
            i.mp_created_at, i.mp_offices, i.mp_sale_price_kopecks,
            ii.sku, ii.name, ii.declared_qty, ii.mp_article, ii.mp_barcode,
            ii.mp_nm_id, ii.mp_rid,
            CASE WHEN ii.id IS NULL THEN 0 ELSE ${LEFT_TO_PICK_SQL} END AS left_to_pick,
            NOT (${UNPICKABLE_SQL}) AS pickable,
            ${WB_CONFIRMED_SQL} AS wb_confirmed
       FROM invoices i
       LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE i.warehouse_id = $1
        AND i.company_id = $2
        AND i.direction = 'out'
        AND i.supply_id IS NULL
        AND i.status <> 'shipped'
        AND i.mp_closed_at IS NULL
      ORDER BY i.created_at DESC, i.number`,
    [warehouseId, companyId],
  );
  // Товара хватит? Сперва — поставкам, что уже собираются, потом очереди,
  // старшим заказам первыми: так же склад и будет их собирать.
  const cover = await stockCover(client, warehouseId, companyId);
  const stockShort = new Set();
  const byAge = [...r.rows].sort((a, b) => new Date(a.mp_created_at || a.created_at)
    - new Date(b.mp_created_at || b.created_at));
  for (const x of byAge) {
    if (x.sku && !cover.take(`${companyId}|${x.sku}`, Number(x.left_to_pick || 0))) stockShort.add(x.id);
  }
  return r.rows.map((x) => ({
    id: x.id,
    number: x.number,
    createdAt: x.created_at,
    // Когда покупатель оформил заказ на площадке (у заказа из 1С — нет).
    orderedAt: x.mp_created_at,
    offices: x.mp_offices || [],
    salePriceKopecks: x.mp_sale_price_kopecks == null ? null : Number(x.mp_sale_price_kopecks),
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
    wbConfirmed: Boolean(x.wb_confirmed),
    ready: Boolean(x.pickable) && !x.wb_confirmed,
    // По учёту на полках не хватит — поставку с таким заказом склад
    // полностью не соберёт. Решать лучше сейчас, а не у пустой ячейки.
    stockShort: stockShort.has(x.id),
  }));
}

// Разобрать поставку.
//
// Собрали не то — надо иметь возможность вернуть заказы в очередь. Разрешено
// только пока поставка «собирается»: после отбора товар уже снят с полок,
// а уехавшую поставку не разбирают в базе, её разгружают руками.
async function disband(client, warehouseId, supplyId, { actor }) {
  const s = await client.query(
    'SELECT id, number, status, mp_supply_id FROM supplies WHERE warehouse_id = $1 AND id = $2 FOR UPDATE',
    [warehouseId, supplyId],
  );
  const supply = s.rows[0];
  if (!supply) throw new HttpError(404, 'Поставка не найдена');
  if (supply.status !== 'collecting') {
    throw new HttpError(409,
      `Поставка «${supply.number}» уже ${STATUS_NAMES[supply.status] || supply.status}`
      + ' — разобрать её в Аргусе нельзя.');
  }
  await client.query(`SELECT id FROM invoices WHERE warehouse_id=$1 AND supply_id=$2 ORDER BY id FOR UPDATE`, [warehouseId, supplyId]);
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
  // Поставка уже заведена на площадке: её заказы там числятся «на сборке».
  // Удалив строку молча, мы теряем номер поставки WB — она остаётся висеть в
  // кабинете продавца, а её заказы больше нельзя ни собрать, ни вернуть.
  if (supply.mp_supply_id) {
    throw new HttpError(409,
      `Поставка «${supply.number}» уже создана на площадке (${supply.mp_supply_id}).`
      + ' Сначала удалите её в кабинете WB, иначе заказы останутся числиться на сборке там.');
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
      + `${plural(freed.rowCount, 'заказ', 'заказа', 'заказов')} ${freed.rowCount === 1 ? 'вернулся' : 'вернулись'} в очередь.`,
    entityType: 'supply',
    entityId: supplyId,
    actorType: actor?.type || 'owner',
    actorId: actor?.id || null,
  });
  return { number: supply.number, returned: freed.rowCount };
}

// Убрать один заказ из поставки — обычно потому, что грузчик отметил «нет
// товара».
//
// Без этого один ненайденный товар держал поставку навсегда: «Уехала» ждёт,
// пока соберут каждый заказ, а «Разобрать» запрещено, как только по поставке
// отобрали хоть что-то. Теперь заказ возвращается в очередь менеджера, а
// поставка едет без него — и сама становится «собранной», если остальное
// собрано.
//
// Убрать можно только заказ, по которому ещё ничего не отобрали: отобранное
// снято с полки, и «вернуть в очередь» значило бы отобрать его второй раз.
async function removeOrder(client, warehouseId, invoiceId, { actor, canResolveShortages = false }) {
  // Порядок блокировок тот же, что у отбора и отгрузки: поставка, потом заказ.
  const supplyId = await lockSupplyOfInvoice(client, warehouseId, invoiceId);
  const inv = await client.query(
    `SELECT i.id, i.number, i.supply_id, s.number AS supply_number, s.status AS supply_status,
            s.mp_supply_id
       FROM invoices i LEFT JOIN supplies s ON s.id = i.supply_id
      WHERE i.warehouse_id = $1 AND i.id = $2 FOR UPDATE OF i`,
    [warehouseId, invoiceId],
  );
  const order = inv.rows[0];
  if (!order) throw new HttpError(404, 'Заказ не найден');
  if (!order.supply_id || order.supply_id !== supplyId) {
    throw new HttpError(409, `Заказ «${order.number}» не в поставке — убирать неоткуда`);
  }
  if (order.supply_status === 'shipped') {
    throw new HttpError(409, `Поставка «${order.supply_number}» уже уехала — назад её не вернуть`);
  }
  // Поставка уже заведена на площадке: там заказ числится в её составе, и
  // убрать его только у себя — значит разойтись с WB.
  if (order.mp_supply_id) {
    throw new HttpError(409,
      `Поставка «${order.supply_number}» уже создана на площадке (${order.mp_supply_id}) — `
      + 'заказ числится в ней и там. Убрать его только в Аргусе нельзя.');
  }
  const picked = await client.query(
    `SELECT COALESCE(SUM(sr.picked_qty), 0)::int AS qty FROM shipping_records sr
       JOIN invoice_items ii ON ii.id = sr.invoice_item_id
      WHERE ii.invoice_id = $1 AND sr.warehouse_id = $2`,
    [invoiceId, warehouseId],
  );
  if (Number(picked.rows[0].qty) > 0) {
    throw new HttpError(409,
      `По заказу «${order.number}» уже отобрано ${picked.rows[0].qty} шт. — товар снят с полки, `
      + 'поэтому убрать заказ из поставки нельзя. Убрать можно только заказ, по которому ещё ничего не отбирали.');
  }
  const others = await client.query(
    'SELECT count(*)::int AS n FROM invoices WHERE warehouse_id = $1 AND supply_id = $2 AND id <> $3',
    [warehouseId, supplyId, invoiceId],
  );
  // Пустая поставка осталась бы строкой без заказов (как ПС-1409-01) —
  // для этого есть «Разобрать».
  if (Number(others.rows[0].n) === 0) {
    throw new HttpError(409,
      `Это единственный заказ поставки «${order.supply_number}» — разберите поставку целиком.`);
  }

  // Отметки «нет товара» по этому заказу решаются самим действием: без ответа
  // они висели бы «очень важно» по заказу, которого в поставке уже нет. Решает
  // их тот, кому они адресованы, — владелец или менеджер с правом «нет товара»;
  // менеджер без права их и не видит.
  const open = await client.query(
    `SELECT je.id FROM journal_entries je
      WHERE je.warehouse_id = $1 AND je.invoice_id = $2 AND je.urgent AND je.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id)`,
    [warehouseId, invoiceId],
  );
  if (open.rows.length > 0 && !canResolveShortages) {
    throw new HttpError(403,
      `По заказу «${order.number}» есть отметка «нет товара» — её решает владелец или менеджер с этим правом`);
  }

  await client.query('UPDATE invoices SET supply_id = NULL WHERE warehouse_id = $1 AND id = $2',
    [warehouseId, invoiceId]);
  await refreshSupplyStatus(client, warehouseId, supplyId);
  const status = await client.query('SELECT status FROM supplies WHERE warehouse_id = $1 AND id = $2',
    [warehouseId, supplyId]);

  const who = actor?.type === 'manager' ? 'менеджером' : 'владельцем';
  const text = `Заказ «${order.number}» убран ${who} из поставки «${order.supply_number}» и вернулся в очередь.`;
  for (const row of open.rows) {
    await journal.resolveEntry(client, {
      warehouseId, originalEntryId: row.id, resolution: 'confirm',
      resolvedByOwnerId: actor?.type === 'owner' ? actor.id || null : null,
      // Кто решил, запись ответа скажет сама («Подтверждено менеджером: …»).
      note: `заказ «${order.number}» убран из поставки «${order.supply_number}» и вернулся в очередь`,
      actorType: actor?.type === 'manager' ? 'manager' : 'owner', actorId: actor?.id || null,
    });
  }
  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText: text,
    entityType: 'supply',
    entityId: supplyId,
    invoiceId,
    actorType: actor?.type || 'owner',
    actorId: actor?.id || null,
  });

  return {
    orderNumber: order.number,
    supplyId,
    supplyNumber: order.supply_number,
    supplyStatus: status.rows[0].status,
    supplyStatusName: STATUS_NAMES[status.rows[0].status],
    answeredMarks: open.rows.length,
  };
}

module.exports = {
  create, contents, ship, list, pendingByCompany, pendingOrders, disband, removeOrder, moscowToday, stockCover, STATUS_NAMES,
};
