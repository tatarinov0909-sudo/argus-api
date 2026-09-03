/* eslint-disable camelcase */

exports.shorthands = undefined;

// Возврат кладёт на полку не только годный товар: брак и брак упаковки тоже
// физически лежат в ячейках (в 1С под это заведены отдельные склады, у нас —
// отдельные ячейки). До этой миграции остаток не различал состояние, и брак,
// положенный в ячейку, ничем не отличался от годного — отгрузка честно
// предлагала работнику взять его для клиентского заказа. Проверено на живом
// стенде: 5 штук брака в ячейке, заказ на 5 штук, «нехватка 0».
//
// Состояние живёт на остатке, а не на ячейке: одна и та же ячейка может
// какое-то время держать и годное, и ждущее перепаковки, а «зона брака» —
// это соглашение склада, а не свойство схемы.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE cell_stock
      ADD COLUMN quality return_quality NOT NULL DEFAULT 'good';

    -- Всё, что лежало до сих пор, приехало приёмкой или годным возвратом:
    -- брака в остатках до этой миграции не было по построению.
    UPDATE cell_stock SET quality = 'good' WHERE quality IS NULL;

    -- Отгрузка ищет товар к отбору по (склад, компания, артикул) и теперь
    -- ещё и по состоянию — индекс должен покрывать тот же запрос.
    DROP INDEX IF EXISTS idx_cell_stock_lookup;
    CREATE INDEX idx_cell_stock_lookup
      ON cell_stock(warehouse_id, company_id, sku, quality);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_cell_stock_lookup;
    CREATE INDEX idx_cell_stock_lookup ON cell_stock(warehouse_id, company_id, sku);
    ALTER TABLE cell_stock DROP COLUMN IF EXISTS quality;
  `);
};
