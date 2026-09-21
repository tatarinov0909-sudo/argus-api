/* eslint-disable camelcase */

exports.shorthands = undefined;

// «Очень важно» у записи журнала.
//
// Грузчик на сборке находит, что товара нет, и отмечает это прямо в заказе
// поставки. Такая отметка не должна тонуть среди сотни обычных записей:
// поставка стоит, пока по ней не решили. Флаг ставится только при вставке —
// журнал по-прежнему только дописывается.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE journal_entries ADD COLUMN urgent BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX idx_journal_urgent ON journal_entries (warehouse_id, created_at DESC) WHERE urgent;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_journal_urgent;
    ALTER TABLE journal_entries DROP COLUMN IF EXISTS urgent;
  `);
};
