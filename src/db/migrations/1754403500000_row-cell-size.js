/* eslint-disable camelcase */

exports.shorthands = undefined;

// Размер одной ячейки ряда (владелец 28.09.2026): при подключении склада
// известны размеры ячеек, у товаров — габариты. Тогда заполнение ячейки
// считается приблизительно: объём лежащего товара / объём ячейки
// (src/cells/fill.js). Объединённая ячейка — сумма мест, которые она
// заняла. Не задано — заполнение неизвестно, как и раньше.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE warehouse_rows
      ADD COLUMN cell_width_cm NUMERIC CHECK (cell_width_cm > 0),
      ADD COLUMN cell_depth_cm NUMERIC CHECK (cell_depth_cm > 0),
      ADD COLUMN cell_height_cm NUMERIC CHECK (cell_height_cm > 0);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE warehouse_rows
      DROP COLUMN cell_width_cm, DROP COLUMN cell_depth_cm, DROP COLUMN cell_height_cm;
  `);
};
