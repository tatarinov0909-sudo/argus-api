/* eslint-disable camelcase */

exports.shorthands = undefined;

// Внешний номер до сих пор означал «ровно один внешний мир» — 1С. Уникальность
// стояла на паре (склад, внешний номер), и это ровно то место, где ломается
// подключение маркетплейсов: один и тот же заказ приходит и из 1С, и с
// площадки, а система обязана считать их разными документами.
//
// Решение принято не сводить их по номеру (разные форматы, частичные совпадения,
// гонки), а держать один источник на пару «продавец + площадка». Но даже при
// этом источник обязан быть частью ключа: пока пара переключается с 1С на
// площадку, в базе живут документы обоих происхождений.
//
// Дефолт '1c' покрывает все существующие строки, поэтому миграция дешёвая и
// ничего не переписывает.
//
// invoice_items намеренно не трогаем: у них индекс по внешнему номеру НЕ
// уникальный, коллизии между источниками там нет, а позиции всегда ищутся
// внутри своей накладной.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices ADD COLUMN source TEXT NOT NULL DEFAULT '1c';

    DROP INDEX IF EXISTS idx_invoices_external;
    CREATE UNIQUE INDEX idx_invoices_external
      ON invoices(warehouse_id, source, external_id) WHERE external_id IS NOT NULL;

    -- Отбор «покажи заказы, приехавшие с этой площадки» — частый и на живой
    -- базе пойдёт по десяткам тысяч строк.
    CREATE INDEX idx_invoices_source ON invoices(warehouse_id, source, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_invoices_source;
    DROP INDEX IF EXISTS idx_invoices_external;
    CREATE UNIQUE INDEX idx_invoices_external
      ON invoices(warehouse_id, external_id) WHERE external_id IS NOT NULL;
    ALTER TABLE invoices DROP COLUMN IF EXISTS source;
  `);
};
