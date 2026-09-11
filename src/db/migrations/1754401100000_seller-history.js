exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Timestamp is written only when Argus confirms a real departure. Older
    -- standalone shipments remain unknown; pick times are not substituted.
    ALTER TABLE invoices ADD COLUMN shipped_at TIMESTAMPTZ;

    -- Read only the addresses referenced by this seller's own recorded work.
    -- No warehouse context is granted to sellers and no write policy changes.
    CREATE POLICY seller_operation_address ON cell_blocks FOR SELECT USING (
      EXISTS (SELECT 1 FROM receiving_records r WHERE r.cell_block_id=cell_blocks.id
        AND r.company_id=NULLIF(current_setting('app.current_company_id',true),'')::uuid)
      OR EXISTS (SELECT 1 FROM shipping_records r WHERE r.cell_block_id=cell_blocks.id
        AND r.company_id=NULLIF(current_setting('app.current_company_id',true),'')::uuid)
      OR EXISTS (SELECT 1 FROM return_records r WHERE r.cell_block_id=cell_blocks.id
        AND r.company_id=NULLIF(current_setting('app.current_company_id',true),'')::uuid)
      OR EXISTS (SELECT 1 FROM stock_operations r
        WHERE (r.from_cell_block_id=cell_blocks.id OR r.to_cell_block_id=cell_blocks.id)
        AND r.company_id=NULLIF(current_setting('app.current_company_id',true),'')::uuid)
    );
    CREATE POLICY seller_operation_row ON warehouse_rows FOR SELECT USING (
      NULLIF(current_setting('app.current_company_id',true),'') IS NOT NULL
      AND EXISTS (SELECT 1 FROM cell_blocks b WHERE b.warehouse_row_id=warehouse_rows.id)
    );

    CREATE INDEX idx_stock_ops_seller_history ON stock_operations(company_id,sku,created_at DESC,id DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_stock_ops_seller_history;
    DROP POLICY IF EXISTS seller_operation_row ON warehouse_rows;
    DROP POLICY IF EXISTS seller_operation_address ON cell_blocks;
    ALTER TABLE invoices DROP COLUMN IF EXISTS shipped_at;
  `);
};
