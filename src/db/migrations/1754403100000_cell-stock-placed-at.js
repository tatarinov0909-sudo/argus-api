/* eslint-disable camelcase */

exports.shorthands = undefined;

// «Когда положили» (владелец 27.09.2026): нажал на ячейку — видно, когда в
// неё положили товар. У строки остатка было только updated_at, а оно
// меняется и при отборе: вчера взяли штуку — и товар, лежащий с весны,
// выглядел положенным вчера. Теперь время укладки — отдельно: ставится при
// появлении строки (приёмка, возврат, перестановка, загрузка остатков) и
// дальше не меняется.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE cell_stock ADD COLUMN placed_at TIMESTAMPTZ;
    -- Старым строкам — последнее известное событие укладки этого товара в эту
    -- ячейку (приёмка, перестановка, загрузка) не позже последнего изменения
    -- строки, а если его нет — само последнее изменение.
    -- Счётчик изменений ячейки (по нему пересчёт сверяет свой снимок) не
    -- трогаем: товар никуда не двигался.
    ALTER TABLE cell_stock DISABLE TRIGGER cell_stock_revision;
    UPDATE cell_stock cs SET placed_at = COALESCE(GREATEST(
      (SELECT MAX(rr.finished_at) FROM receiving_records rr JOIN invoice_items ii ON ii.id = rr.invoice_item_id
        WHERE rr.cell_block_id = cs.cell_block_id AND rr.company_id IS NOT DISTINCT FROM cs.company_id
          AND ii.sku = cs.sku AND rr.finished_at <= cs.updated_at),
      (SELECT MAX(op.created_at) FROM stock_operations op
        WHERE op.to_cell_block_id = cs.cell_block_id AND op.company_id IS NOT DISTINCT FROM cs.company_id
          AND op.sku = cs.sku AND op.created_at <= cs.updated_at)), cs.updated_at);
    ALTER TABLE cell_stock ENABLE TRIGGER cell_stock_revision;
    ALTER TABLE cell_stock ALTER COLUMN placed_at SET DEFAULT now(), ALTER COLUMN placed_at SET NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE cell_stock DROP COLUMN IF EXISTS placed_at;');
};
