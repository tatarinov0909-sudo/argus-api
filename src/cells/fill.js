// Presence of goods is known; physical capacity is not. Item count alone
// cannot say how much of a shelf's volume or weight allowance is occupied.
// No cell-capacity input exists yet, so no percentage is calculated.
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

module.exports = { refreshCellFill };
