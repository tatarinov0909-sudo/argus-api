/* eslint-disable camelcase */

exports.shorthands = undefined;

// Early WB status reconciliation treated every externally completed order as
// a physical discrepancy. That produced owner alerts for orders imported
// after they had already left WB's queue, even though Argus had never picked
// them or added them to a local supply. Reclassify only those system-created
// false positives. The journal rows remain in place as source history.
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE journal_entries je
       SET status = 'auto',
           action_text = 'Заказ «' || i.number || '»: передан в доставку на WB. '
             || 'Отбора или поставки в Аргусе не было; заказ исключён из очереди. '
             || 'Физический остаток и данные 1С не изменялись.'
      FROM invoices i
     WHERE je.invoice_id = i.id
       AND je.agent = 'Обмен с WB'
       AND je.actor_type = 'system'
       AND je.status = 'pending'
       AND i.source = 'wb'
       AND i.mp_close_reason = 'fulfilled'
       AND i.supply_id IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM invoice_items ii
           JOIN shipping_records sr ON sr.invoice_item_id = ii.id
          WHERE ii.invoice_id = i.id AND sr.picked_qty > 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries answer WHERE answer.related_entry_id = je.id
       );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE journal_entries je
       SET status = 'pending',
           action_text = 'Заказ «' || i.number || '»: передан в доставку на WB. '
             || 'Склад должен проверить физический товар в разделе «Сверка заказов WB». '
             || 'Автоматического списания или возврата нет.'
      FROM invoices i
     WHERE je.invoice_id = i.id
       AND je.agent = 'Обмен с WB'
       AND je.actor_type = 'system'
       AND je.status = 'auto'
       AND je.action_text = 'Заказ «' || i.number || '»: передан в доставку на WB. '
             || 'Отбора или поставки в Аргусе не было; заказ исключён из очереди. '
             || 'Физический остаток и данные 1С не изменялись.';
  `);
};
