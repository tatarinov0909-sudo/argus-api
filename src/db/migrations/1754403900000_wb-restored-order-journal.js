/* eslint-disable camelcase */

exports.shorthands = undefined;

// Заказ, вернувшийся из wb_foreign_orders, — с его историей в журнале
// (проверка 01.10.2026). Убирая заказ, settle удаляет его строку, и ссылка
// записей журнала обнуляется (ON DELETE SET NULL). Снимок теперь помнит,
// какие записи были о заказе, а узкая функция возвращает ссылку: журнал
// по-прежнему закрыт для UPDATE, функция трогает только записи без ссылки,
// только на заказ своего склада и только в своём складе.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE wb_foreign_orders ADD COLUMN journal_ids UUID[];

    CREATE FUNCTION relink_journal_invoice(p_entries UUID[], p_invoices UUID[])
    RETURNS INT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      WITH l AS (SELECT * FROM unnest(p_entries, p_invoices) AS l(entry_id, invoice_id)),
      u AS (
        UPDATE journal_entries je SET invoice_id = l.invoice_id
          FROM l JOIN invoices i ON i.id = l.invoice_id
         WHERE je.id = l.entry_id AND je.invoice_id IS NULL
           AND je.warehouse_id = i.warehouse_id
           AND i.warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
        RETURNING 1)
      SELECT count(*)::int FROM u;
    $$;
  `);
  pgm.sql(`
    DO $$
    BEGIN
      REVOKE ALL ON FUNCTION relink_journal_invoice(UUID[], UUID[]) FROM PUBLIC;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT EXECUTE ON FUNCTION relink_journal_invoice(UUID[], UUID[]) TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS relink_journal_invoice(UUID[], UUID[]);
    ALTER TABLE wb_foreign_orders DROP COLUMN IF EXISTS journal_ids;
  `);
};
