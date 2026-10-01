/* eslint-disable camelcase */

exports.shorthands = undefined;

// Скорость остатков и карты склада (проверка 01–02.10.2026, находки 4 и 5,
// test/attack-stock-0110/perf-*.js). Запросы ищут по ключам, для которых не
// было индекса, и база перебирала всю таблицу на каждую строку:
// - остатки продавца (src/sellers/stock.js): штрихкод WB товара ищется по
//   «продавец + артикул», а все индексы связей с WB начинались со склада —
//   на каждый товар читались связи ВСЕХ продавцов (130 с у 12 тыс. товаров);
// - карта склада (src/cells/fill.js): товар строки остатка ищется по «склад +
//   артикул», а индекс товаров — «склад + продавец + артикул» (12–27 с);
// - ячейки продавца в остатках: остаток ищется по продавцу без склада.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_mp_sku_company_sku ON product_marketplace_skus (company_id, sku, marketplace);
    CREATE INDEX IF NOT EXISTS idx_products_warehouse_sku ON products (warehouse_id, sku);
    CREATE INDEX IF NOT EXISTS idx_cell_stock_company_sku ON cell_stock (company_id, sku);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_cell_stock_company_sku;
    DROP INDEX IF EXISTS idx_products_warehouse_sku;
    DROP INDEX IF EXISTS idx_mp_sku_company_sku;
  `);
};
