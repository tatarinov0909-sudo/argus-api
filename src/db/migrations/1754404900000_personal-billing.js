/* eslint-disable camelcase */
// Персональные полные прайсы, неизменяемые счета и записи оплаты.
exports.shorthands = undefined;
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE companies ADD CONSTRAINT companies_warehouse_id_id_unique UNIQUE (warehouse_id, id);
    CREATE TABLE billing_company_tariffs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), warehouse_id UUID NOT NULL, company_id UUID NOT NULL,
      effective_from DATE NOT NULL, prices JSONB NOT NULL,
      storage_unit TEXT NOT NULL CHECK (storage_unit IN ('cell_day', 'unit_day')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT,
      UNIQUE (warehouse_id, company_id, effective_from),
      FOREIGN KEY (warehouse_id, company_id) REFERENCES companies(warehouse_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE billing_company_settings (
      warehouse_id UUID NOT NULL, company_id UUID NOT NULL,
      show_sellers BOOLEAN NOT NULL DEFAULT false, enabled BOOLEAN NOT NULL DEFAULT false,
      cadence TEXT NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('daily', 'weekly', 'monthly', 'custom')),
      interval_days INT NOT NULL DEFAULT 30 CHECK (interval_days BETWEEN 1 AND 366),
      start_date DATE, next_start DATE,
      payment_days INT NOT NULL DEFAULT 7 CHECK (payment_days BETWEEN 0 AND 366),
      last_attempt_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT,
      PRIMARY KEY (warehouse_id, company_id),
      CHECK (NOT enabled OR (start_date IS NOT NULL AND next_start IS NOT NULL)),
      FOREIGN KEY (warehouse_id, company_id) REFERENCES companies(warehouse_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE billing_invoices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), warehouse_id UUID NOT NULL, company_id UUID NOT NULL,
      period_from DATE NOT NULL, period_to DATE NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(), due_date DATE NOT NULL,
      company_name TEXT NOT NULL, lines JSONB NOT NULL,
      total_cents BIGINT NOT NULL CHECK (total_cents >= 0), issued_by TEXT,
      CHECK (period_to >= period_from), UNIQUE (warehouse_id, company_id, period_from, period_to),
      UNIQUE (warehouse_id, company_id, id),
      FOREIGN KEY (warehouse_id, company_id) REFERENCES companies(warehouse_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE billing_payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), warehouse_id UUID NOT NULL, company_id UUID NOT NULL,
      invoice_id UUID NOT NULL, amount_cents BIGINT NOT NULL CHECK (amount_cents > 0), paid_on DATE NOT NULL,
      note TEXT NOT NULL DEFAULT '', idempotency_key UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by TEXT,
      UNIQUE (warehouse_id, invoice_id, idempotency_key),
      FOREIGN KEY (warehouse_id, company_id, invoice_id) REFERENCES billing_invoices(warehouse_id, company_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX billing_invoices_company_date ON billing_invoices(warehouse_id, company_id, issued_at DESC, id DESC);
    CREATE INDEX billing_payments_invoice ON billing_payments(warehouse_id, invoice_id);
    CREATE INDEX billing_receiving_period ON receiving_records(warehouse_id,company_id,finished_at);
    CREATE INDEX billing_returns_period ON return_records(warehouse_id,company_id,finished_at);
    CREATE INDEX billing_picking_source ON shipping_records(warehouse_id,company_id,invoice_item_id,finished_at)
      WHERE finished_at IS NOT NULL AND picked_qty>0;
    -- Копируем только действительно сохранённый прайс, с даты миграции в
    -- поясе склада. Примерные ставки и прошлые цены не восстанавливаем.
    INSERT INTO billing_company_tariffs (warehouse_id,company_id,effective_from,prices,storage_unit,updated_by)
      SELECT c.warehouse_id,c.id,(now() AT TIME ZONE COALESCE(w.timezone,'Europe/Moscow'))::date,
        t.prices,t.storage_unit,'перенос сохранённого прайса'
      FROM companies c JOIN warehouses w ON w.id=c.warehouse_id JOIN billing_tariffs t ON t.warehouse_id=c.warehouse_id
      WHERE c.archived_at IS NULL;
    INSERT INTO billing_company_settings (warehouse_id,company_id,show_sellers)
      SELECT c.warehouse_id,c.id,t.show_sellers FROM companies c JOIN billing_tariffs t ON t.warehouse_id=c.warehouse_id
      WHERE c.archived_at IS NULL;
    DO $$ DECLARE tab TEXT; BEGIN
      FOREACH tab IN ARRAY ARRAY['billing_company_tariffs','billing_company_settings','billing_invoices','billing_payments'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
        EXECUTE format('CREATE POLICY warehouse_write ON %I FOR ALL USING
          (warehouse_id=NULLIF(current_setting(''app.current_warehouse_id'',true),'''')::uuid)
          WITH CHECK (warehouse_id=NULLIF(current_setting(''app.current_warehouse_id'',true),'''')::uuid)', tab);
        EXECUTE format('CREATE POLICY seller_read ON %I FOR SELECT USING
          (company_id=NULLIF(current_setting(''app.current_company_id'',true),'''')::uuid)', tab);
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
          EXECUTE format('GRANT SELECT,INSERT ON %I TO argus_app', tab);
        END IF;
      END LOOP;
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
        GRANT UPDATE ON billing_company_tariffs,billing_company_settings TO argus_app;
      END IF;
    END $$;
    CREATE FUNCTION protect_billing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Выставленный счёт и запись оплаты неизменяемы'; END;
    $$;
    CREATE TRIGGER billing_invoice_immutable BEFORE UPDATE OR DELETE ON billing_invoices
      FOR EACH ROW EXECUTE FUNCTION protect_billing_snapshot();
    CREATE TRIGGER billing_payment_immutable BEFORE UPDATE OR DELETE ON billing_payments
      FOR EACH ROW EXECUTE FUNCTION protect_billing_snapshot();
  `);
};
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX billing_picking_source; DROP INDEX billing_returns_period; DROP INDEX billing_receiving_period;
    DROP TABLE billing_payments; DROP TABLE billing_invoices; DROP FUNCTION protect_billing_snapshot();
    DROP TABLE billing_company_settings; DROP TABLE billing_company_tariffs;
    ALTER TABLE companies DROP CONSTRAINT companies_warehouse_id_id_unique;`);
};
