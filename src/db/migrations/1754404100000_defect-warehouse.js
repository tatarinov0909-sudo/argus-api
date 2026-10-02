/* eslint-disable camelcase */

exports.shorthands = undefined;

// Склад брака продавца (владелец 02.10.2026, «способ 2»).
//
// Сам брак, как и раньше, лежит в ячейках — строки cell_stock с состоянием
// «брак» или «брак упаковки»: остаток склада брака — это они. Здесь — то,
// чего не хватало вокруг:
// - defect_moves — документы «Перемещение на склад брака»: откуда брак
//   взялся (возврат, приёмка, сборка, перекладка, пересчёт, загрузка
//   остатков), сколько, описание, фото по желанию, кто отметил;
// - defect_decisions — решения по браку: продавец (или склад за него) решил,
//   что делать с N штуками товара; пока склад не выполнил — задание
//   грузчику;
// - cell_blocks.defect_zone — ячейки, которые руководитель отметил под брак:
//   их Аргус предлагает первыми.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE defect_moves (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      number TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT,
      qty NUMERIC NOT NULL CHECK (qty > 0 AND qty = trunc(qty)),
      bucket TEXT NOT NULL CHECK (bucket IN ('defective', 'packaging_defect')),
      note TEXT CHECK (note IS NULL OR length(note) <= 300),
      source TEXT NOT NULL CHECK (source IN ('return', 'receiving', 'picking', 'move', 'inventory', 'initial_load')),
      invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
      supply_id UUID REFERENCES supplies(id) ON DELETE SET NULL,
      cell_block_id UUID REFERENCES cell_blocks(id) ON DELETE SET NULL,
      batch TEXT,
      photo BYTEA,
      photo_type TEXT,
      photo_size INTEGER,
      photo_at TIMESTAMPTZ,
      created_by UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (warehouse_id, number)
    );
    CREATE INDEX defect_moves_company ON defect_moves (company_id, created_at DESC);
    CREATE INDEX defect_moves_batch ON defect_moves (warehouse_id, batch) WHERE batch IS NOT NULL;

    CREATE TABLE defect_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      number TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT,
      bucket TEXT NOT NULL CHECK (bucket IN ('defective', 'packaging_defect')),
      qty NUMERIC NOT NULL CHECK (qty > 0 AND qty = trunc(qty)),
      action TEXT NOT NULL CHECK (action IN ('return_to_seller', 'dispose', 'repack', 'markdown')),
      markdown_barcode TEXT,
      markdown_sku TEXT,
      note TEXT CHECK (note IS NULL OR length(note) <= 300),
      decided_role TEXT NOT NULL CHECK (decided_role IN ('seller', 'owner', 'manager')),
      decided_by UUID,
      decided_name TEXT,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      seller_seen_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
      done_by UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      done_name TEXT,
      done_at TIMESTAMPTZ,
      done_cell_block_id UUID REFERENCES cell_blocks(id) ON DELETE SET NULL,
      done_cells JSONB,
      CHECK ((status = 'done') = (done_at IS NOT NULL)),
      CHECK (action <> 'markdown' OR markdown_barcode IS NOT NULL),
      UNIQUE (warehouse_id, number)
    );
    CREATE INDEX defect_decisions_company ON defect_decisions (company_id, decided_at DESC);
    CREATE INDEX defect_decisions_pending ON defect_decisions (warehouse_id, status) WHERE status = 'pending';

    ALTER TABLE cell_blocks ADD COLUMN defect_zone BOOLEAN NOT NULL DEFAULT false;
    -- Шаг раскладки приёмки помнит состояние: брак при приёмке ложится в
    -- ячейку брака своим шагом, а «Переложить» и «Убрать» работают с годным.
    ALTER TABLE receiving_placements ADD COLUMN quality TEXT NOT NULL DEFAULT 'good'
      CHECK (quality IN ('good', 'defective', 'packaging_defect'));

    ALTER TABLE defect_moves ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON defect_moves USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
    ALTER TABLE defect_decisions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON defect_decisions USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON defect_moves, defect_decisions TO argus_app;
    END IF; END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE receiving_placements DROP COLUMN IF EXISTS quality;
    ALTER TABLE cell_blocks DROP COLUMN IF EXISTS defect_zone;
    DROP TABLE IF EXISTS defect_decisions;
    DROP TABLE IF EXISTS defect_moves;
  `);
};
