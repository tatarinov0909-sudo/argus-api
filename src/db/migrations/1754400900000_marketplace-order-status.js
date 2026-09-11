exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices
      ADD COLUMN mp_supplier_status TEXT,
      ADD COLUMN mp_status TEXT,
      ADD COLUMN mp_status_checked_at TIMESTAMPTZ,
      ADD COLUMN mp_status_attempted_at TIMESTAMPTZ,
      ADD COLUMN mp_closed_at TIMESTAMPTZ,
      ADD COLUMN mp_close_reason TEXT CHECK (mp_close_reason IN ('canceled', 'fulfilled')),
      ADD COLUMN mp_stock_returned_at TIMESTAMPTZ;
    CREATE INDEX idx_invoices_mp_status_poll
      ON invoices (warehouse_id, company_id, mp_status_attempted_at NULLS FIRST, id)
      WHERE source = 'wb' AND status <> 'shipped' AND mp_stock_returned_at IS NULL
        AND (mp_closed_at IS NULL OR mp_close_reason = 'fulfilled');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_invoices_mp_status_poll;
    ALTER TABLE invoices DROP COLUMN mp_supplier_status, DROP COLUMN mp_status,
      DROP COLUMN mp_status_checked_at, DROP COLUMN mp_status_attempted_at,
      DROP COLUMN mp_closed_at, DROP COLUMN mp_close_reason,
      DROP COLUMN mp_stock_returned_at;`);
};
