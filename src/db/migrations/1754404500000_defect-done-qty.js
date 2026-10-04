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

// Откат не должен молча терять сделанное: решение, выполненное частично,
// после отката выглядело бы невыполненным (проверка 03.10.2026).
exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM defect_decisions WHERE status = 'pending' AND done_qty > 0) THEN
        RAISE EXCEPTION 'Есть решения по браку, выполненные частично, — откат потерял бы сделанное';
      END IF;
    END $$;
    ALTER TABLE defect_decisions DROP COLUMN IF EXISTS done_qty;
  `);
};
