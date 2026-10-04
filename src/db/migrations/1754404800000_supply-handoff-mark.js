/* eslint-disable camelcase */
// Передача поставки в WB идёт (рецензия 03.10, R11; владелец 04.10: починить
// до включения записи в WB). Пока WB не ответил, поставку нельзя разобрать
// и убрать из неё заказ: иначе на WB поставка с заказом появится, а в
// Аргусе её уже не будет.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql('ALTER TABLE supplies ADD COLUMN mp_handoff_at TIMESTAMPTZ;');
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE supplies DROP COLUMN IF EXISTS mp_handoff_at;');
};
