/* eslint-disable camelcase */

exports.shorthands = undefined;

// Поставка физлицу создаётся один раз на одно окно «Новая поставка»
// (проверка 07.10, замечание 2): два человека или повтор запроса после
// обрыва связи создавали две поставки — и товар собрали бы дважды.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE supplies ADD COLUMN request_id UUID;
    CREATE UNIQUE INDEX supplies_request_id ON supplies (warehouse_id, request_id) WHERE request_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS supplies_request_id; ALTER TABLE supplies DROP COLUMN IF EXISTS request_id;');
};
