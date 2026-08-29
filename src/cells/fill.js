// Заполненность ячейки в процентах.
//
// Считается от условной вместимости: сколько штук помещается в одну ячейку.
// Настоящую вместимость взять неоткуда — габаритов и веса нет ни у одной
// позиции номенклатуры (0 из 11 849 на день написания), а без них объём товара
// не посчитать.
//
// Поэтому здесь соглашение, а не измерение, и оно вынесено в одну константу:
// когда в 1С появятся размеры, процент надо будет считать от них, и правка
// будет ровно в этом файле. Раньше три разных места писали fill_pct = 100 при
// любом количестве, из-за чего карта красила оранжевым и ячейку с пятью
// штуками — то есть сообщала «склад забит», когда он пуст.
const CELL_CAPACITY_UNITS = 500;

// Пересчитывает состояние и процент по тому, что реально лежит в ячейке.
// Вызывать после любого изменения cell_stock — приёмки, отгрузки, объединения.
//
// GREATEST(...,1) нужен, чтобы ячейка с одной штукой не показывалась пустой:
// ноль процентов на занятой ячейке читается как «свободна», а это ложь.
async function refreshCellFill(client, cellBlockId) {
  await client.query(
    `UPDATE cell_blocks cb
     SET state = CASE WHEN s.qty > 0 THEN 'occupied'::cell_state ELSE 'empty'::cell_state END,
         fill_pct = CASE WHEN s.qty > 0
                         THEN LEAST(100, GREATEST(1, round(s.qty / $2::numeric * 100)::int))
                         ELSE 0 END,
         updated_at = now()
     FROM (SELECT COALESCE(SUM(qty), 0) AS qty FROM cell_stock WHERE cell_block_id = $1) s
     WHERE cb.id = $1`,
    [cellBlockId, CELL_CAPACITY_UNITS],
  );
}

module.exports = { refreshCellFill, CELL_CAPACITY_UNITS };
