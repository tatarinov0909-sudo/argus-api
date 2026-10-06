/* eslint-disable camelcase */

exports.shorthands = undefined;

// Поставка «из всего товара продавца» (владелец 06.10.2026): у продавца есть
// виртуальные склады, а собрать нужно из любого — грузчик берёт товар с любого
// его склада. Заказы такой поставки за складом не закрепляются (vw null).
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE supplies ADD COLUMN vw_any BOOLEAN NOT NULL DEFAULT false;');
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE supplies DROP COLUMN IF EXISTS vw_any;');
};
