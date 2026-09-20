async function loadStock(client, companyId) {
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
                  (i.supply_id IS NOT NULL OR EXISTS (
                     SELECT 1 FROM shipping_records sx JOIN invoice_items ix ON ix.id=sx.invoice_item_id
                      WHERE ix.invoice_id=i.id AND ix.company_id=$1 AND sx.company_id=$1 AND sx.picked_qty>0
                   )) AS in_assembly,
                  (i.mp_closed_at IS NOT NULL) AS closed
           FROM invoices i
           JOIN invoice_items ii ON ii.invoice_id = i.id
           WHERE i.company_id = $1 AND ii.company_id = $1
             AND i.direction = 'out' AND i.status <> 'shipped'
             AND (i.mp_closed_at IS NULL OR (i.mp_stock_returned_at IS NULL AND (i.supply_id IS NOT NULL OR EXISTS (
               SELECT 1 FROM shipping_records sx JOIN invoice_items ix ON ix.id=sx.invoice_item_id
               WHERE ix.invoice_id=i.id AND ix.company_id=$1 AND sx.company_id=$1 AND sx.picked_qty>0
             ))))
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
                o.assembly_qty, o.queued_qty, o.queued_orders, o.assembly_orders
         FROM skus s
         LEFT JOIN prod p ON p.sku = s.sku
         LEFT JOIN cells c ON c.sku = s.sku
         LEFT JOIN ordered o ON o.sku = s.sku
         LEFT JOIN staged st ON st.sku = s.sku
         LEFT JOIN observed obs ON obs.sku = s.sku
         LEFT JOIN accepted a ON a.sku = s.sku
         ORDER BY name`,
        [companyId],
      );
  const rows = result.rows;
    return rows.map((r) => {
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
      const total = accountingTotal === null ? null : Math.max(0, accountingTotal);
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
        ? null : Math.max(0, total - inAssembly - orderedNotInSupply);
      // Заказов больше, чем товара по учёту: об этом продавец должен знать,
      // а не гадать, почему «доступно» ноль.
      const shortage = total === null
        ? false : inAssembly + orderedNotInSupply > total;
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
      totalUpdatedAt: accountingTotal === null ? null : (r.stock_at || null),
      inAssembly,
      orderedNotInSupply,
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
      };
    });
}

module.exports = { loadStock };
