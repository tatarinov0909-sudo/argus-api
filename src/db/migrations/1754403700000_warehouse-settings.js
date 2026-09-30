/* eslint-disable camelcase */

exports.shorthands = undefined;

// Настройки склада — анкета фулфилмента (владелец 30.09.2026): система
// подстраивается под ответы ФФ, а не под первый склад «Восход». Вопросов —
// минимум, всё можно поменять позже на экране «Настройки склада».
//
//   stock_source   — где учёт остатков: '1c' (число «Всего» у продавца — из
//                    1С) или 'argus' (по ячейкам Аргуса); NULL — не ответил;
//   timezone       — пояс склада: «сегодня», номера поставок, утренняя сводка;
//   wb_supplies_by — кто оформляет поставку в кабинете WB: 'ff' или 'seller';
//   wb_names       — как ещё ФФ называют продавцы в складах WB (кроме
//                    названия склада) — для автоотметки «наш склад»;
//   setup_at       — когда анкету заполнили;
//   wb_offices_auto_at — когда Аргус сам добавил пункты приёмки WB.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE warehouses
      ADD COLUMN stock_source TEXT CHECK (stock_source IN ('1c', 'argus')),
      ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
      ADD COLUMN wb_supplies_by TEXT CHECK (wb_supplies_by IN ('ff', 'seller')),
      ADD COLUMN wb_names TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN setup_at TIMESTAMPTZ,
      ADD COLUMN wb_offices_auto_at TIMESTAMPTZ;
    -- Склад, у которого уже идёт обмен с 1С, ведёт учёт в 1С.
    UPDATE warehouses w SET stock_source = '1c'
     WHERE EXISTS (SELECT 1 FROM products p WHERE p.warehouse_id = w.id AND p.stock_qty_1c IS NOT NULL);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE warehouses
      DROP COLUMN IF EXISTS stock_source, DROP COLUMN IF EXISTS timezone,
      DROP COLUMN IF EXISTS wb_supplies_by, DROP COLUMN IF EXISTS wb_names,
      DROP COLUMN IF EXISTS setup_at, DROP COLUMN IF EXISTS wb_offices_auto_at;
  `);
};
