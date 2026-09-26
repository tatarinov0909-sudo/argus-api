/* eslint-disable camelcase */

exports.shorthands = undefined;

// Привоз товара на склад по логике фулфилмента (владелец 26.09.2026):
// грузоместа, окно выгрузки, «машина приехала», документы поставщика,
// переписка по приходу и ответ продавца на акт расхождений.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices
      ADD COLUMN boxes INTEGER CHECK (boxes >= 0),
      ADD COLUMN pallets INTEGER CHECK (pallets >= 0),
      ADD COLUMN weight_kg NUMERIC CHECK (weight_kg >= 0),
      ADD COLUMN planned_from TIME,
      ADD COLUMN planned_to TIME,
      ADD COLUMN arrived_at TIMESTAMPTZ,
      ADD COLUMN arrived_boxes INTEGER CHECK (arrived_boxes >= 0),
      ADD COLUMN arrived_pallets INTEGER CHECK (arrived_pallets >= 0),
      ADD COLUMN seller_verdict TEXT CHECK (seller_verdict IN ('agreed', 'disputed')),
      ADD COLUMN seller_verdict_at TIMESTAMPTZ,
      ADD COLUMN seller_verdict_note TEXT;

    -- УПД, ТТН и т.п.: реквизиты и, если приложили, сам файл (скан, PDF).
    CREATE TABLE invoice_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      number TEXT,
      doc_date DATE,
      supplier TEXT,
      file_name TEXT,
      file_type TEXT,
      file_size INTEGER,
      file_data BYTEA,
      added_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX invoice_documents_invoice ON invoice_documents(invoice_id);

    -- Переписка склада и продавца по приходу; sku — если про одну строку.
    CREATE TABLE invoice_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      sku TEXT,
      author_role TEXT NOT NULL,
      author_name TEXT,
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX invoice_comments_invoice ON invoice_comments(invoice_id, created_at);

    -- Номер отменённого привоза больше не выдаётся: иначе новый приход
    -- получал тот же номер, а журнал писал, что такой отменён.
    CREATE TABLE inbound_canceled_numbers (
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      number TEXT NOT NULL,
      PRIMARY KEY (warehouse_id, number)
    );
    ALTER TABLE inbound_canceled_numbers ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON inbound_canceled_numbers USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    ALTER TABLE invoice_documents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON invoice_documents USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
    ALTER TABLE invoice_comments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON invoice_comments USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_documents, invoice_comments, inbound_canceled_numbers TO argus_app;
    END IF; END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS inbound_canceled_numbers;
    DROP TABLE IF EXISTS invoice_comments;
    DROP TABLE IF EXISTS invoice_documents;
    ALTER TABLE invoices
      DROP COLUMN IF EXISTS boxes, DROP COLUMN IF EXISTS pallets, DROP COLUMN IF EXISTS weight_kg,
      DROP COLUMN IF EXISTS planned_from, DROP COLUMN IF EXISTS planned_to,
      DROP COLUMN IF EXISTS arrived_at, DROP COLUMN IF EXISTS arrived_boxes, DROP COLUMN IF EXISTS arrived_pallets,
      DROP COLUMN IF EXISTS seller_verdict, DROP COLUMN IF EXISTS seller_verdict_at, DROP COLUMN IF EXISTS seller_verdict_note;
  `);
};
