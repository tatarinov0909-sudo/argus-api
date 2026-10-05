/* eslint-disable camelcase */

exports.shorthands = undefined;

// Подпись поставок в кабинете WB (владелец 05.10.2026): имя поставки на WB —
// «подпись + наш номер», например «Восход ПС-051026-02». Склад меняет её сам
// в настройках; пусто — берётся название склада.
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE warehouses ADD COLUMN wb_supply_label TEXT;');
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE warehouses DROP COLUMN IF EXISTS wb_supply_label;');
};
