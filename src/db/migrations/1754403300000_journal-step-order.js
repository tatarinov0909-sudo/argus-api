/* eslint-disable camelcase */

exports.shorthands = undefined;

// Порядок записей журнала внутри одной транзакции (третье задание
// 27.09.2026). now() в Postgres — время начала транзакции, и все записи одной
// транзакции получали одно время: последняя позиция прихода и «закончил
// приёмку — закрыта сама», записанные вместе, в развёрнутой строке работы
// шли вразнобой. clock_timestamp() — время самой вставки: шаги встают в том
// порядке, в каком были сделаны.
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE journal_entries ALTER COLUMN created_at SET DEFAULT clock_timestamp();');
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE journal_entries ALTER COLUMN created_at SET DEFAULT now();');
};
