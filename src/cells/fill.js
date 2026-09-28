// Пересчитывает состояние по тому, что реально лежит в ячейке.
// Вызывать после любого изменения cell_stock — приёмки, отгрузки, объединения.
//
async function refreshCellFill(client, cellBlockId) {
  await client.query(
    `UPDATE cell_blocks cb
     SET state = CASE WHEN s.qty > 0 THEN 'occupied'::cell_state ELSE 'empty'::cell_state END,
         fill_pct = NULL,
         updated_at = now()
     FROM (SELECT COALESCE(SUM(qty), 0) AS qty FROM cell_stock WHERE cell_block_id = $1) s
     WHERE cb.id = $1`,
    [cellBlockId],
  );
}

// Насколько заполнена ячейка — приблизительно (владелец 28.09.2026): объём
// лежащего товара (штуки × габариты карточки) / объём ячейки (размер ячейки
// ряда × сколько мест заняла объединённая). Считается при чтении, а не
// хранится: габариты приходят из 1С и меняются, размер ячеек правят.
//
// Честно, а не «как получится»: не задан размер ячеек ряда или у любого
// лежащего товара нет габаритов — процента нет, есть причина.
//
// blockId — одна ячейка; без него — все занятые ячейки склада одним запросом.
async function cellFills(client, warehouseId, blockId = null) {
  const r = await client.query(
    `SELECT cb.id,
            (cb.rack_end - cb.rack_start + 1) * wr.cell_width_cm * wr.cell_depth_cm
              * (cb.tier_end - cb.tier_start + 1) * wr.cell_height_cm AS cell_cm3,
            SUM(cs.qty * p.length_mm * p.width_mm * p.height_mm) / 1000.0 AS goods_cm3,
            (array_agg(COALESCE(p.name, cs.sku) ORDER BY cs.sku)
               FILTER (WHERE p.length_mm IS NULL OR p.width_mm IS NULL OR p.height_mm IS NULL))[1] AS no_size
       FROM cell_blocks cb
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       JOIN cell_stock cs ON cs.cell_block_id = cb.id AND cs.qty > 0
       LEFT JOIN LATERAL (
         SELECT p.name, p.length_mm, p.width_mm, p.height_mm FROM products p
          WHERE p.warehouse_id = cs.warehouse_id AND p.sku = cs.sku
          ORDER BY (p.company_id IS NOT DISTINCT FROM cs.company_id) DESC LIMIT 1) p ON true
      WHERE cb.warehouse_id = $1 AND ($2::uuid IS NULL OR cb.id = $2::uuid)
      GROUP BY cb.id, wr.id`,
    [warehouseId, blockId],
  );
  return new Map(r.rows.map((x) => [x.id, fillOf(x)]));
}

function fillOf({ cell_cm3: cell, goods_cm3: goods, no_size: noSize }) {
  if (cell == null) return { pct: null, reason: 'no_cell_size' };
  if (noSize != null) return { pct: null, reason: 'no_product_size', product: noSize };
  const pct = Math.round((Number(goods) / Number(cell)) * 100);
  // Меньше процента, но товар лежит — «1%», а не «пусто».
  return { pct: Math.max(1, pct), freeLiters: Math.round((Number(cell) - Number(goods)) / 1000) };
}

module.exports = { refreshCellFill, cellFills, fillOf };
