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
         ), prod AS (
           SELECT sku, name, barcode, stock_qty_1c, stock_at
           FROM products
           WHERE company_id = $1
         ), ordered AS (
           -- Сколько этого товара уже обещано заказами и ещё не уехало.
           --
           -- Считаем ВСЕ неотгруженные заказы, а не только несобранные.
           -- Собранный, но не уехавший заказ лежит в коробке у ворот: из
           -- ячейки он уже списан, а из учёта 1С — ещё нет, потому что
           -- реализация проводится при отгрузке. Не вычти его — и продавцу
           -- обещано то, что физически уже уезжает.
           SELECT ii.sku, SUM(ii.declared_qty) AS qty,
                  SUM(ii.declared_qty) FILTER (WHERE i.mp_closed_at IS NOT NULL) AS blocked_qty,
                  count(DISTINCT i.id) AS orders,
                  count(DISTINCT i.id) FILTER (WHERE i.status = 'ready') AS picked_orders
           FROM invoices i
           JOIN invoice_items ii ON ii.invoice_id = i.id
           WHERE i.company_id = $1 AND i.direction = 'out' AND i.status <> 'shipped'
             AND (i.mp_closed_at IS NULL OR (i.mp_stock_returned_at IS NULL AND (i.mp_close_reason='fulfilled' OR EXISTS (
               SELECT 1 FROM shipping_records sx JOIN invoice_items ix ON ix.id=sx.invoice_item_id
               WHERE ix.invoice_id=i.id AND ix.company_id=$1 AND sx.company_id=$1 AND sx.picked_qty>0
             ))))
           GROUP BY ii.sku
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
         )
         SELECT s.sku,
                COALESCE(p.name, (SELECT ii.name FROM invoice_items ii
                                  WHERE ii.company_id = $1 AND ii.sku = s.sku
                                  ORDER BY ii.id DESC LIMIT 1),
                         s.sku) AS name,
                c.good_qty, c.bad_qty, c.defective_qty, c.packaging_qty, c.cells,
                c.stock_records, GREATEST(c.counted_at,obs.at) AS counted_at, obs.sku AS observed_sku,
                p.barcode, p.stock_qty_1c, p.stock_at, st.qty AS staged_qty,
                o.qty AS ordered_qty, o.blocked_qty, o.orders, o.picked_orders
         FROM skus s
         LEFT JOIN prod p ON p.sku = s.sku
         LEFT JOIN cells c ON c.sku = s.sku
         LEFT JOIN ordered o ON o.sku = s.sku
         LEFT JOIN staged st ON st.sku = s.sku
         LEFT JOIN observed obs ON obs.sku = s.sku
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
      return {
      sku: r.sku,
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
      qtyIn1c: r.stock_qty_1c === null || r.stock_qty_1c === undefined
        ? null : Number(r.stock_qty_1c),
      stockAt: r.stock_at || null,
      // Три числа, которые продавец и звонит спрашивать.
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
