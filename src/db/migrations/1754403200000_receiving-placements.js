/* eslint-disable camelcase */

exports.shorthands = undefined;

// Укладки приёмки (владелец 27.09.2026, третье задание): одну позицию
// прихода можно разложить по нескольким ячейкам — 30 шт. в 1.7.3 и 6 шт. в
// 1.2.1. Принятое количество и расхождение по-прежнему одно на позицию — это
// receiving_records, и в 1С уходит одна приёмка позиции. А где лежит товар —
// здесь, строкой на каждую ячейку.
//
// Каждая строка — отдельный шаг «N шт. в ячейку X»: позже его подтвердят
// сканом QR ячейки и товара (confirmed_*), поэтому укладки не склеиваются —
// и одна ячейка в одной приёмке позиции встречается один раз.
//
// receiving_records.cell_block_id остаётся ячейкой первой укладки: на неё
// ведёт запись журнала, и по ней старые отчёты видят «размещено».
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE receiving_placements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      receiving_record_id UUID NOT NULL REFERENCES receiving_records(id) ON DELETE CASCADE,
      invoice_item_id UUID NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      -- Ячейку могут разобрать при перестройке карты — укладка остаётся в
      -- истории приёмки, просто без адреса (как у receiving_records).
      cell_block_id UUID REFERENCES cell_blocks(id) ON DELETE SET NULL,
      sku TEXT NOT NULL,
      qty NUMERIC NOT NULL CHECK (qty > 0),
      -- Порядок шагов: как грузчик раскладывал.
      step INT NOT NULL CHECK (step > 0),
      placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      placed_by UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      -- Задел под скан QR ячейки и товара: пока пусто у всех.
      confirmed_at TIMESTAMPTZ,
      confirmed_by UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      confirm_method TEXT CHECK (confirm_method IS NULL OR confirm_method IN ('qr')),
      UNIQUE (receiving_record_id, step)
    );
    CREATE UNIQUE INDEX receiving_placements_one_cell
      ON receiving_placements (receiving_record_id, cell_block_id) WHERE cell_block_id IS NOT NULL;
    CREATE INDEX receiving_placements_item ON receiving_placements (invoice_item_id);
    CREATE INDEX receiving_placements_cell ON receiving_placements (cell_block_id, placed_at DESC);
    CREATE INDEX receiving_placements_company ON receiving_placements (company_id);

    -- Как у receiving_records: склад видит свои, продавец — укладки своего
    -- товара (адреса ему не отдаются — это делают маршруты, как и раньше).
    ALTER TABLE receiving_placements ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON receiving_placements USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE ON receiving_placements TO argus_app;
    END IF; END $$;

    -- Всё, что уже принято в ячейку, — одна укладка на позицию.
    INSERT INTO receiving_placements
      (receiving_record_id, invoice_item_id, warehouse_id, company_id, cell_block_id, sku, qty, step, placed_at, placed_by)
    SELECT rr.id, rr.invoice_item_id, rr.warehouse_id, rr.company_id, rr.cell_block_id, ii.sku, rr.accepted_qty, 1,
           COALESCE(rr.finished_at, rr.started_at), rr.worker_key_id
      FROM receiving_records rr JOIN invoice_items ii ON ii.id = rr.invoice_item_id
     WHERE rr.cell_block_id IS NOT NULL AND rr.accepted_qty > 0;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS receiving_placements;');
};
