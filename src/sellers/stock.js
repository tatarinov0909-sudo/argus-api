const wbListing = require('./wbListing');

// Одно правило для четырёх чисел продавца и для списка заказов за ними
// (задание 27.09.2026: список под числом обязан совпадать с числом).
// $1 — продавец. «В сборке» — заказ в поставке или по нему уже отбирали.
const IN_ASSEMBLY_SQL = `(i.supply_id IS NOT NULL OR EXISTS (
                     SELECT 1 FROM shipping_records sx JOIN invoice_items ix ON ix.id=sx.invoice_item_id
                      WHERE ix.invoice_id=i.id AND ix.company_id=$1 AND sx.company_id=$1 AND sx.picked_qty>0
                   ))`;
// Заказ ещё обещан покупателю: не уехал и не закрыт WB — или закрыт, но
// товар уже в работе и на полку не вернулся (склад сверяет).
const DEMAND_SQL = `(i.status <> 'shipped'
             AND (i.mp_closed_at IS NULL OR (i.mp_stock_returned_at IS NULL AND ${IN_ASSEMBLY_SQL})))`;
// «В пути» (владелец 26.09.2026): уехало поставкой на WB, WB ещё не принял.
// Заказ не с площадки (физлицу, из 1С) WB не примет никогда — уехал, и всё
// (владелец 06.10.2026), иначе висел бы «В пути» вечно.
const TRANSIT_SQL = `(i.status = 'shipped' AND i.supply_id IS NOT NULL AND i.source <> '1c' AND i.mp_closed_at IS NULL)`;
// Под каким числом у продавца стоит строка заказа: ordered | assembly | transit | null.
const BUCKET_SQL = `CASE WHEN ${TRANSIT_SQL} THEN 'transit'
                         WHEN ${DEMAND_SQL} THEN CASE WHEN ${IN_ASSEMBLY_SQL} THEN 'assembly' ELSE 'ordered' END
                    END`;

// source — где склад ведёт учёт остатков (анкета склада, warehouses.stock_source):
// '1c' — «Всего» из 1С; 'argus' — по ячейкам Аргуса (склад без 1С).
async function loadStock(client, companyId, { source = '1c' } = {}) {
      const result = await client.query(
        `WITH cells AS (
           SELECT sku,
                  SUM(qty) FILTER (WHERE quality = 'good') AS good_qty,
                  SUM(qty) FILTER (WHERE quality <> 'good') AS bad_qty,
                  SUM(qty) FILTER (WHERE quality = 'defective') AS defective_qty,
                  SUM(qty) FILTER (WHERE quality = 'packaging_defect') AS packaging_qty,
                  count(DISTINCT cell_block_id) FILTER (WHERE qty > 0) AS cells,
                  count(*) AS stock_records, MAX(updated_at) AS counted_at
           FROM cell_stock
           WHERE company_id = $1
           GROUP BY sku
         ), observed AS (
           -- A fully picked SKU can have no cell rows left. Warehouse operations
           -- distinguish that known zero from a catalogue card never received.
           SELECT sku, MAX(at) AS at FROM (
             SELECT ii.sku, rr.finished_at AS at FROM receiving_records rr
             JOIN invoice_items ii ON ii.id=rr.invoice_item_id
             WHERE rr.company_id=$1 AND (rr.cell_block_id IS NOT NULL OR rr.accepted_qty=0)
             UNION ALL
             SELECT ii.sku, sr.finished_at FROM shipping_records sr
             JOIN invoice_items ii ON ii.id=sr.invoice_item_id
             WHERE sr.company_id=$1 AND sr.picked_qty IS NOT NULL
             UNION ALL
             SELECT ii.sku, rr.finished_at FROM return_records rr
             JOIN invoice_items ii ON ii.id=rr.invoice_item_id
             WHERE rr.company_id=$1 AND rr.cell_block_id IS NOT NULL
             UNION ALL
             SELECT sku,created_at FROM stock_operations WHERE company_id=$1
           ) operations GROUP BY sku
         ), accepted_snapshot AS (
           SELECT id,observed_at,accepted_at
           FROM seller_inventory_snapshots
           WHERE company_id=$1 AND status='accepted'
           ORDER BY accepted_at DESC,id DESC
           LIMIT 1
         ), accepted AS (
           SELECT i.sku,i.quantity,s.id AS snapshot_id,
                  COALESCE(s.observed_at,s.accepted_at) AS snapshot_at
           FROM accepted_snapshot s
           JOIN seller_inventory_snapshot_items i ON i.snapshot_id=s.id
         ), prod AS (
           SELECT p.sku, p.name,
                  COALESCE(NULLIF(BTRIM(p.barcode), ''), mapped.barcode) AS barcode,
                  p.stock_qty_1c, p.stock_at
           FROM products p
           LEFT JOIN LATERAL (
             SELECT CASE WHEN COUNT(DISTINCT BTRIM(m.mp_barcode)) = 1
                         THEN MAX(BTRIM(m.mp_barcode)) END AS barcode
             FROM product_marketplace_skus m
             WHERE m.company_id = p.company_id
               AND m.sku = p.sku
               AND m.marketplace = 'wb'
               AND NULLIF(BTRIM(m.mp_barcode), '') IS NOT NULL
           ) mapped ON true
           WHERE p.company_id = $1 AND p.active = true
         ), demand_rows AS (
           -- Обещанный покупателям товар, который ещё не уехал, с разделением
           -- на две судьбы (решение владельца 17.09.2026):
           --   «заказано»  — купили на площадке, поставки ещё нет;
           --   «в сборке»  — заказ уже в поставке, переданной на склад,
           --                 или по нему уже отбирали товар.
           -- Считаем и собранные, но не уехавшие заказы: из ячейки товар
           -- списан, а из учёта 1С ещё нет — реализация проводится при
           -- отгрузке. Не вычти их, и продавцу обещано то, что уже уезжает.
           SELECT ii.sku, ii.declared_qty, i.id AS invoice_id, i.status,
                  ${IN_ASSEMBLY_SQL} AS in_assembly,
                  (i.mp_closed_at IS NOT NULL) AS closed
           FROM invoices i
           JOIN invoice_items ii ON ii.invoice_id = i.id
           WHERE i.company_id = $1 AND ii.company_id = $1
             AND i.direction = 'out' AND ${DEMAND_SQL}
         ), ordered AS (
           SELECT sku,
                  SUM(declared_qty) AS qty,
                  SUM(declared_qty) FILTER (WHERE in_assembly) AS assembly_qty,
                  SUM(declared_qty) FILTER (WHERE NOT in_assembly) AS queued_qty,
                  SUM(declared_qty) FILTER (WHERE closed) AS blocked_qty,
                  count(DISTINCT invoice_id) AS orders,
                  count(DISTINCT invoice_id) FILTER (WHERE NOT in_assembly) AS queued_orders,
                  count(DISTINCT invoice_id) FILTER (WHERE in_assembly) AS assembly_orders,
                  count(DISTINCT invoice_id) FILTER (WHERE status = 'ready') AS picked_orders
           FROM demand_rows GROUP BY sku
         ), staged AS (
           -- Picks have left their cells, but remain on site until shipment.
           -- Include partial picks as well as fully assembled orders.
           SELECT ii.sku, SUM(sr.picked_qty) AS qty
           FROM shipping_records sr
           JOIN invoice_items ii ON ii.id = sr.invoice_item_id
           JOIN invoices i ON i.id = ii.invoice_id
           WHERE sr.company_id = $1 AND i.direction = 'out' AND i.status <> 'shipped'
             AND i.mp_stock_returned_at IS NULL
           GROUP BY ii.sku
         ), in_transit AS (
           -- «В пути» (владелец 26.09.2026): уехало со склада поставкой на WB,
           -- а WB его ещё не принял. Принятый WB заказ обмен статусов
           -- закрывает (mp_closed_at), отменённый — тоже.
           SELECT ii.sku, SUM(ii.declared_qty) AS qty
           FROM invoices i
           JOIN invoice_items ii ON ii.invoice_id = i.id
           WHERE i.company_id = $1 AND ii.company_id = $1 AND i.direction = 'out'
             AND ${TRANSIT_SQL}
           GROUP BY ii.sku
         ), aligned AS (
           -- Последняя сверка склада с файлом остатков: тогда ячейки и учёт
           -- совпали. Что уехало поставкой позже, 1С может ещё числить —
           -- пока отгрузку в ней не провели (владелец 06.10.2026).
           SELECT max(created_at) AS at FROM stock_operations
            WHERE company_id = $1 AND kind IN ('document_align', 'initial_load')
         ), taken_by_wb AS (
           -- Ушло после сверки и на полке его нет: принято WB из поставки,
           -- отгружено без поставки — вручную, физлицу (владелец 06.10.2026),
           -- или отменено WB уже после отгрузки: посылка едет назад возвратом
           -- (проверка 07.10, Н4). Вычитается не больше, чем 1С числит сверх
           -- полки, — вернётся возврат на полку, и вычитать станет нечего.
           SELECT ii.sku, SUM(ii.declared_qty) AS qty
           FROM invoices i
           JOIN invoice_items ii ON ii.invoice_id = i.id
           LEFT JOIN supplies s ON s.id = i.supply_id
           WHERE i.company_id = $1 AND ii.company_id = $1 AND i.direction = 'out'
             AND i.status = 'shipped' AND (i.supply_id IS NULL OR i.source = '1c' OR i.mp_close_reason IN ('fulfilled', 'canceled'))
             AND COALESCE(s.shipped_at, i.shipped_at) > (SELECT at FROM aligned)
           GROUP BY ii.sku
         ), accepted_wb AS (
           -- «Принято WB» (владелец 06.10.2026): сколько штук из поставок
           -- сортировочный центр WB принял за последние 3 дня — по времени
           -- приёмки; дольше висеть не нужно, поставки остаются в истории.
           SELECT ii.sku, SUM(ii.declared_qty) AS qty
           FROM invoices i
           JOIN invoice_items ii ON ii.invoice_id = i.id
           WHERE i.company_id = $1 AND ii.company_id = $1 AND i.direction = 'out'
             AND i.status = 'shipped' AND i.supply_id IS NOT NULL AND i.mp_close_reason = 'fulfilled'
             AND i.mp_closed_at > now() - interval '3 days'
           GROUP BY ii.sku
         ), skus AS (
           SELECT sku FROM prod
           UNION SELECT sku FROM cells
           UNION SELECT sku FROM ordered
           UNION SELECT sku FROM observed
           UNION SELECT sku FROM accepted
         )
         SELECT s.sku, p.sku AS product_sku,
                COALESCE(p.name, (SELECT ii.name FROM invoice_items ii
                                  WHERE ii.company_id = $1 AND ii.sku = s.sku
                                  ORDER BY ii.id DESC LIMIT 1),
                         s.sku) AS name,
                c.good_qty, c.bad_qty, c.defective_qty, c.packaging_qty, c.cells,
                c.stock_records, GREATEST(c.counted_at,obs.at) AS counted_at, obs.sku AS observed_sku,
                p.barcode, p.stock_qty_1c, p.stock_at, st.qty AS staged_qty,
                a.quantity AS accepted_qty,a.snapshot_id,a.snapshot_at,
                o.qty AS ordered_qty, o.blocked_qty, o.orders, o.picked_orders,
                o.assembly_qty, o.queued_qty, o.queued_orders, o.assembly_orders,
                tr.qty AS transit_qty, tw.qty AS taken_qty, aw.qty AS accepted_wb_qty
         FROM skus s
         LEFT JOIN prod p ON p.sku = s.sku
         LEFT JOIN cells c ON c.sku = s.sku
         LEFT JOIN ordered o ON o.sku = s.sku
         LEFT JOIN staged st ON st.sku = s.sku
         LEFT JOIN observed obs ON obs.sku = s.sku
         LEFT JOIN accepted a ON a.sku = s.sku
         LEFT JOIN in_transit tr ON tr.sku = s.sku
         LEFT JOIN taken_by_wb tw ON tw.sku = s.sku
         LEFT JOIN accepted_wb aw ON aw.sku = s.sku
         ORDER BY name`,
        [companyId],
      );
  const rows = result.rows;
  // Раскладка по виртуальным складам продавца (02.10.2026) — только если
  // склады заведены: у остальных продавцов ответ прежний.
  const vws = (await client.query(
    'SELECT id, name FROM virtual_warehouses WHERE company_id = $1 AND archived_at IS NULL ORDER BY created_at', [companyId])).rows;
  const split = vws.length ? await loadSplit(client, companyId) : null;
    const out = rows.map((r) => {
      // Warehouse stock includes picked goods still waiting for departure.
      // 1C is a separate reconciliation source, never a fallback balance.
      const staged = Number(r.staged_qty || 0);
      const onHand = Number(r.good_qty || 0) + staged;
      const ordered = Number(r.ordered_qty || 0);
      const stockKnown = Number(r.stock_records || 0) > 0 || r.observed_sku != null;
      // The latest accounting balance from 1C is the seller-facing total.
      // Accepted file snapshots remain stored for audit, but they must not
      // freeze the cabinet after a newer automatic 1C exchange arrives.
      const accountingTotal = r.stock_qty_1c === null || r.stock_qty_1c === undefined
        ? null : Number(r.stock_qty_1c);
      // Склад без 1С (владелец 30.09.2026): учёт склада — это ячейки Аргуса.
      // «Всего» — годное в ячейках плюс собранное, но ещё не уехавшее: так же,
      // как у 1С, где товар списывается только при отгрузке. Товар, которого
      // склад ещё ни разу не видел, — «не знаем», а не ноль.
      const byCells = source === 'argus';
      // «Всего» — весь товар, пока WB его не принял, вместе с «В пути»
      // (владелец 06.10.2026): в ячейках уехавшего уже нет — прибавляем.
      const inTransit = Number(r.transit_qty || 0);
      // Едущее и принятое WB продать нельзя (владелец 06.10.2026). 1С
      // списывает уехавшее, когда отгрузку в ней проведут, — сразу или через
      // дни: что 1С числит сверх лежащего на складе, — это и есть ещё не
      // списанное уехавшее (едущее и принятое WB после сверки с файлом).
      // Без ячеек — считаем, что 1С числит всё едущее.
      // ponytail: по расхождению 1С с ячейками; ячейки больше 1С — уехавшее
      // сочтётся списанным. Точнее — вопрос анкеты, когда доделаем обмен с 1С.
      const left = byCells || !stockKnown || accountingTotal === null ? inTransit
        : Math.min(inTransit + Number(r.taken_qty || 0), Math.max(0, accountingTotal - onHand));
      const transitCounted = Math.min(inTransit, left);
      // Принятое WB, которое 1С ещё числит, — уже не «Всего».
      const takenCounted = left - transitCounted;
      const total = byCells
        ? (stockKnown ? Math.max(0, onHand) + inTransit : null)
        : (accountingTotal === null ? null : Math.max(0, accountingTotal - takenCounted));
      // Четыре числа продавца (решение владельца 17.09.2026):
      // «в сборке» — заказы, переданные складу поставкой (или уже
      // отобранные), «заказано» — купленное на площадке, чего в поставке
      // ещё нет. Оба уменьшают доступное: товар обещан покупателю.
      // Больше, чем есть на складе, обещать нельзя — поэтому обрезаем по
      // остатку, сначала сборкой: она ближе к отгрузке.
      const assemblyDemand = Number(r.assembly_qty || 0);
      const queuedDemand = Number(r.queued_qty || 0);
      // Сами числа не режем: «в сборке 5» и «заказано 3» — это про заказы,
      // и обрезка по остатку 1С показывала ноль там, где заказы есть. Режем
      // только «доступно»: обещать больше, чем лежит, нельзя.
      const inAssembly = assemblyDemand;
      const orderedNotInSupply = queuedDemand;
      const sellerAvailable = total === null
        ? null : Math.max(0, total - inAssembly - orderedNotInSupply - transitCounted);
      // Заказов больше, чем товара по учёту: об этом продавец должен знать,
      // а не гадать, почему «доступно» ноль.
      const shortage = total === null
        ? false : inAssembly + orderedNotInSupply + transitCounted > total;
      return {
      sku: r.sku,
      shortage,
      listed: r.product_sku != null,
      name: r.name,
      barcode: r.barcode || null,
      stockKnown,
      countedAt: r.counted_at || null,
      staged,
      defective: Number(r.defective_qty || 0),
      packagingDefect: Number(r.packaging_qty || 0),
      // Годное и негодное раздельно: «на складе 40» без оговорки, что 8 из них
      // брак, — это обещание отгрузить то, что отгружено не будет.
      qty: Number(r.good_qty || 0),
      notForSale: Number(r.bad_qty || 0),
      cells: Number(r.cells || 0),
      // Цифра из 1С склада и время, когда она пришла. Без времени нельзя
      // отличить «на складе ноль» от «обмен молчит вторую неделю».
      qtyIn1c: accountingTotal,
      stockAt: r.stock_at || null,
      acceptedSnapshotId: r.snapshot_id || null,
      acceptedSnapshotAt: r.snapshot_at || null,
      // Stable seller contract. The public route exposes only these business
      // quantities; it does not reveal 1C, cells, or reconciliation details.
      total,
      totalKnown: total !== null,
      totalUpdatedAt: byCells ? (r.counted_at || null) : (accountingTotal === null ? null : (r.stock_at || null)),
      inAssembly,
      orderedNotInSupply,
      inTransit,
      // Сколько «В пути» вычтено из «Доступно» (часть 1С могла уже списать).
      transitCounted,
      acceptedByWb: Number(r.accepted_wb_qty || 0),
      sellerAvailable,
      // Сколько заказов стоит за каждым числом — для подписей в кабинете.
      queuedOrders: Number(r.queued_orders || 0),
      assemblyOrders: Number(r.assembly_orders || 0),
      onHand: stockKnown ? onHand : null,
      ordered,
      blockedOrdered: Number(r.blocked_qty || 0),
      orderedOrders: Number(r.orders || 0),
      // Count of fully assembled orders, not the number of picked units.
      orderedPicked: Number(r.picked_orders || 0),
      // Отрицательным быть не может: заказов больше, чем товара, — это
      // расхождение, а не долг. Показываем ноль и говорим об этом отдельно.
      available: stockKnown ? Math.max(0, onHand - ordered) : null,
      short: stockKnown ? Math.max(0, ordered - onHand) : null,
      ...(split ? { byWarehouse: splitOf(split, r.sku, vws, { total, source, inTransit: transitCounted }) } : {}),
      };
    });
  await addKits(client, companyId, out);
  return out;
}

// Наборы (владелец 08.10.2026): «Свободно» набора — готовые наборы плюс
// сколько можно собрать из свободных частей. Части продаются и поштучно,
// поэтому в итоги продавца это не идёт (посчиталось бы дважды) — только в
// строку набора (kitBuildable) и в сравнение с «На WB» (wbListing.js).
// Часть без учёта — «не знаем», а не ноль: собрать сколько — тоже неизвестно.
async function addKits(client, companyId, rows) {
  const parts = (await client.query(
    'SELECT kit_sku, component_sku, qty FROM product_kits WHERE company_id = $1', [companyId])).rows;
  if (!parts.length) return;
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  const kits = new Map();
  for (const p of parts) {
    if (!kits.has(p.kit_sku)) kits.set(p.kit_sku, []);
    kits.get(p.kit_sku).push(p);
  }
  for (const [kit, list] of kits) {
    const row = bySku.get(kit);
    if (!row) continue;
    let buildable = Infinity;
    for (const p of list) {
      const free = bySku.get(p.component_sku)?.sellerAvailable;
      if (free == null) { buildable = null; break; }
      buildable = Math.min(buildable, Math.floor(free / Number(p.qty)));
    }
    row.kitParts = list.length;
    row.kitBuildable = buildable;
  }
}

// Сколько товара на каждом виртуальном складе: годное в ячейках и собранное,
// но не уехавшее (по складу строки), что уже в поставках с этого склада и
// брак, пришедший с него.
async function loadSplit(client, companyId) {
  const r = await client.query(
    `SELECT sku, vw, SUM(good) AS good, SUM(bad) AS bad, SUM(staged) AS staged, SUM(assembly) AS assembly FROM (
       SELECT sku, virtual_warehouse_id AS vw,
              COALESCE(SUM(qty) FILTER (WHERE quality = 'good'), 0) AS good,
              COALESCE(SUM(qty) FILTER (WHERE quality <> 'good'), 0) AS bad, 0 AS staged, 0 AS assembly
         FROM cell_stock WHERE company_id = $1 AND qty > 0 GROUP BY sku, virtual_warehouse_id
       UNION ALL
       SELECT ii.sku, ii.virtual_warehouse_id, 0, 0, SUM(sr.picked_qty), 0
         FROM shipping_records sr JOIN invoice_items ii ON ii.id = sr.invoice_item_id JOIN invoices i ON i.id = ii.invoice_id
        WHERE sr.company_id = $1 AND i.direction = 'out' AND i.status <> 'shipped' AND i.mp_stock_returned_at IS NULL
        GROUP BY ii.sku, ii.virtual_warehouse_id
       UNION ALL
       SELECT ii.sku, ii.virtual_warehouse_id, 0, 0, 0, SUM(ii.declared_qty)
         FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
        WHERE i.company_id = $1 AND ii.company_id = $1 AND i.direction = 'out' AND ${DEMAND_SQL} AND ${IN_ASSEMBLY_SQL}
        GROUP BY ii.sku, ii.virtual_warehouse_id
     ) x GROUP BY sku, vw`, [companyId]);
  const map = new Map();
  for (const x of r.rows) {
    if (!map.has(x.sku)) map.set(x.sku, new Map());
    map.get(x.sku).set(x.vw || '', {
      good: Number(x.good), bad: Number(x.bad), staged: Number(x.staged), assembly: Number(x.assembly),
    });
  }
  return map;
}

// «Остальной товар» — всё, что не на заведённых складах (владелец 03.10.2026;
// «Основной» — весь товар вместе): при учёте в 1С это «Всего»
// из 1С минус остальные склады (1С о складах Аргуса не знает), при учёте в
// Аргусе — его ячейки. «Заказано» (заказы вне поставки) склада не имеет —
// оно только в общем итоге.
function splitOf(split, sku, vws, { total, source, inTransit = 0 }) {
  const bySku = split.get(sku) || new Map();
  const at = (id) => bySku.get(id || '') || { good: 0, bad: 0, staged: 0, assembly: 0 };
  const others = vws.map((w) => {
    const a = at(w.id);
    const onHand = a.good + a.staged;
    return { id: w.id, name: w.name, onHand, inAssembly: a.assembly, available: Math.max(0, onHand - a.assembly), defect: a.bad };
  });
  const main = at(null);
  const mainOnHand = source === 'argus'
    ? main.good + main.staged
    : (total === null ? null : Math.max(0, total - inTransit - others.reduce((n, w) => n + w.onHand, 0)));
  // «Остальной товар» — последним: сначала склады продавца.
  return others.concat([{
    id: null, name: 'Остальной товар', onHand: mainOnHand, inAssembly: main.assembly,
    available: mainOnHand === null ? null : Math.max(0, mainOnHand - main.assembly), defect: main.bad,
  }]);
}

// Итог по продавцу — одно правило для кабинета продавца, сводки владельца
// «Остатки продавцов» и чата Кладовщика (владелец 02.10.2026).
//
// Только товары каталога продавца: строка заказа без товара не придумывает
// ни товар, ни остаток. «Всего» и «Доступно» — по товарам, у которых есть
// число учёта; товары без него названы отдельно (unknownNames), а не прячут
// всё число прочерком: один тестовый товар, заведённый в Аргусе, гасил итог
// по восьмидесяти (владелец 30.09.2026). Прочерк — когда не знаем ни одного.
function summarize(rows) {
  const inventoryRows = rows.filter((row) => row.listed);
  const knownRows = inventoryRows.filter((row) => row.totalKnown);
  const unknownRows = inventoryRows.filter((row) => !row.totalKnown);
  const shortRows = inventoryRows.filter((row) => row.shortage);
  const sum = (source, field) => source.reduce((total, row) => total + Number(row[field] || 0), 0);
  // Сортировка строк давала не самую свежую дату, а последнюю по алфавиту.
  const updatedAt = inventoryRows
    .map((row) => row.totalUpdatedAt)
    .filter(Boolean)
    .reduce((latest, value) => (!latest || new Date(value) > new Date(latest) ? value : latest), null);
  return {
    productCount: inventoryRows.length,
    total: knownRows.length ? sum(knownRows, 'total') : null,
    ordered: sum(inventoryRows, 'orderedNotInSupply'),
    inAssembly: sum(inventoryRows, 'inAssembly'),
    inTransit: sum(inventoryRows, 'inTransit'),
    // Сколько «В пути» вычтено из «Доступно» — часть уехавшего 1С могла уже
    // списать, тогда её нет и во «Всего» (проверка 07.10, замечание 6).
    transitDeducted: sum(inventoryRows, 'transitCounted'),
    acceptedByWb: sum(inventoryRows, 'acceptedByWb'),
    available: knownRows.length ? sum(knownRows, 'sellerAvailable') : null,
    defect: sum(inventoryRows, 'defective') + sum(inventoryRows, 'packagingDefect'),
    // Заказов больше, чем товара по учёту.
    shortageCount: shortRows.length,
    unknownCount: unknownRows.length,
    unknownNames: unknownRows.slice(0, 5).map((row) => row.name || row.sku),
    updatedAt,
  };
}

// Сводка по всем продавцам склада: итог каждого — тем же summarize, что
// видит сам продавец, — и сколько его товара лежит в ячейках (это видит
// только склад). Продавцы по алфавиту, архивные не показываем.
// ponytail: loadStock по каждому продавцу подряд (~0,1–0,3 с на продавца);
// на сотне продавцов — один общий запрос по складу.
async function stockBySeller(client, warehouseId) {
  const source = (await client.query('SELECT stock_source FROM warehouses WHERE id = $1', [warehouseId]))
    .rows[0]?.stock_source === 'argus' ? 'argus' : '1c';
  const companies = (await client.query(
    `SELECT id, name FROM companies WHERE warehouse_id = $1 AND archived_at IS NULL ORDER BY name`,
    [warehouseId])).rows;
  const out = [];
  for (const c of companies) {
    const rows = await loadStock(client, c.id, { source });
    out.push({
      companyId: c.id,
      name: c.name,
      ...summarize(rows),
      // Товаров, которых на WB выставлено больше, чем свободно.
      wbOver: await wbListing.annotate(client, warehouseId, c.id, rows),
      inCells: rows.reduce((s, r) => s + Number(r.qty || 0) + Number(r.notForSale || 0), 0),
    });
  }
  return { source, sellers: out };
}

// «Главная» склада: у каких продавцов на WB выставлено больше, чем свободно
// (владелец 06.10.2026). Только продавцы с отмеченными складами WB.
async function wbOverBySeller(client, warehouseId) {
  const source = (await client.query('SELECT stock_source FROM warehouses WHERE id = $1', [warehouseId]))
    .rows[0]?.stock_source === 'argus' ? 'argus' : '1c';
  const companies = (await client.query(
    `SELECT DISTINCT c.id, c.name FROM companies c
       JOIN seller_wb_warehouses w ON w.company_id = c.id AND w.warehouse_id = c.warehouse_id AND w.ours
      WHERE c.warehouse_id = $1 AND c.archived_at IS NULL ORDER BY c.name`, [warehouseId])).rows;
  const out = [];
  for (const c of companies) {
    const count = await wbListing.annotate(client, warehouseId, c.id, await loadStock(client, c.id, { source }));
    if (count) out.push({ companyId: c.id, name: c.name, count });
  }
  return out;
}

module.exports = { loadStock, BUCKET_SQL, summarize, stockBySeller, wbOverBySeller };
