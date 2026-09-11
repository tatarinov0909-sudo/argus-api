exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE cell_blocks ADD COLUMN stock_revision BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE inventory_tasks ADD COLUMN opened_stock_revision BIGINT;
    ALTER TABLE inventory_tasks ADD COLUMN opened_snapshot_id UUID;
    ALTER TABLE inventory_tasks ADD COLUMN resolved_by_staff_key_id UUID REFERENCES staff_keys(id) ON DELETE SET NULL;
    -- A person can explicitly confirm zero for a SKU not previously observed.
    -- Preserve that fact in history without inventing a receipt or positive move.
    ALTER TABLE stock_operations DROP CONSTRAINT stock_operations_qty_check;
    ALTER TABLE stock_operations ADD CONSTRAINT stock_operations_qty_check
      CHECK (qty > 0 OR (qty = 0 AND kind = 'inventory'));

    -- A monotonic revision also detects removed rows and delete/insert cycles.
    -- The parent row serializes new inserts even when the cell has no stock yet.
    CREATE FUNCTION bump_cell_stock_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE block_id uuid;
    BEGIN
      FOR block_id IN
        SELECT DISTINCT id FROM unnest(ARRAY[
          CASE WHEN TG_OP <> 'INSERT' THEN OLD.cell_block_id ELSE NULL END,
          CASE WHEN TG_OP <> 'DELETE' THEN NEW.cell_block_id ELSE NULL END
        ]) AS changed(id) WHERE id IS NOT NULL ORDER BY id
      LOOP
        UPDATE cell_blocks SET stock_revision = stock_revision + 1 WHERE id = block_id;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER cell_stock_revision BEFORE INSERT OR UPDATE OR DELETE ON cell_stock
      FOR EACH ROW EXECUTE FUNCTION bump_cell_stock_revision();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER cell_stock_revision ON cell_stock;
    DROP FUNCTION bump_cell_stock_revision();
    ALTER TABLE inventory_tasks DROP COLUMN opened_stock_revision;
    ALTER TABLE inventory_tasks DROP COLUMN opened_snapshot_id;
    ALTER TABLE inventory_tasks DROP COLUMN resolved_by_staff_key_id;
    ALTER TABLE cell_blocks DROP COLUMN stock_revision;
    ALTER TABLE stock_operations DROP CONSTRAINT stock_operations_qty_check;
    ALTER TABLE stock_operations ADD CONSTRAINT stock_operations_qty_check CHECK (qty > 0);
  `);
};
