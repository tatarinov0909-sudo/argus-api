/* eslint-disable camelcase */
// Решение по браку выполняется частями и на найденное количество
// (проверка 03.10.2026): брак двух складов продавца, один из которых
// «хранить отдельно», кладут в разные ячейки — двумя заходами; брака стало
// меньше, чем решено, — выполняют на найденное, продавцу уведомление.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE defect_decisions ADD COLUMN done_qty INT NOT NULL DEFAULT 0;
    UPDATE defect_decisions SET done_qty = qty WHERE status = 'done';
  `);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE defect_decisions DROP COLUMN IF EXISTS done_qty;');
};
