exports.up = (pgm) => pgm.sql(`
  CREATE INDEX journal_warehouse_related ON journal_entries(warehouse_id,related_entry_id) WHERE related_entry_id IS NOT NULL;
  CREATE INDEX journal_pending_date ON journal_entries(warehouse_id,created_at DESC,id DESC) WHERE status='pending';
`);
exports.down = (pgm) => pgm.sql('DROP INDEX journal_pending_date; DROP INDEX journal_warehouse_related;');
