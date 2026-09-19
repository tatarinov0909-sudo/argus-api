/* eslint-disable camelcase */

exports.shorthands = undefined;

// Параметры отгрузки поставки на WB: пункт приёма и дата. Без них WB не
// принимает «передать в доставку» (409) — для продавцов РФ это обязательно.
// Способ отгрузки не храним: склад возит сам (решение владельца 19.09.2026).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE supplies
      ADD COLUMN ship_date DATE,
      ADD COLUMN mp_shipping_point_id BIGINT,
      ADD COLUMN mp_shipping_set_at TIMESTAMPTZ;

    COMMENT ON COLUMN supplies.ship_date IS 'Плановая дата отгрузки, которую менеджер назвал при составлении';
    COMMENT ON COLUMN supplies.mp_shipping_point_id IS 'Пункт отгрузки площадки (id из списка пунктов WB)';
    COMMENT ON COLUMN supplies.mp_shipping_set_at IS 'Когда параметры отгрузки приняты площадкой';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE supplies
      DROP COLUMN IF EXISTS ship_date,
      DROP COLUMN IF EXISTS mp_shipping_point_id,
      DROP COLUMN IF EXISTS mp_shipping_set_at;
  `);
};
