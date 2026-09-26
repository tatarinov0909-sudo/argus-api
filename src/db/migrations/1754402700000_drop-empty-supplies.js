/* eslint-disable camelcase */

exports.shorthands = undefined;

// Поставки, из которых раньше ушли все заказы, висели пустыми «собирается».
// Теперь такие разбираются сами (supplies/state.js); здесь — те, что остались
// с прошлого. Уже заведённые на WB не трогаем. Номер остаётся занятым.
exports.up = (pgm) => {
  pgm.sql(`
    WITH dropped AS (
      DELETE FROM supplies s
       WHERE s.status = 'collecting' AND s.mp_supply_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.supply_id = s.id)
      RETURNING s.id, s.warehouse_id, s.number)
    INSERT INTO journal_entries (warehouse_id, agent, action_text, entity_type, entity_id, actor_type, status)
    SELECT warehouse_id, 'Кладовщик',
           'Поставка «' || number || '» разобрана сама: в ней не осталось заказов — собирать нечего.',
           'supply', id, 'system', 'auto'
      FROM dropped
  `);
};

exports.down = () => {};
