/* eslint-disable camelcase */

exports.shorthands = undefined;

// Виртуальные склады продавца (схема одобрена владельцем 02.10.2026,
// docs/Виртуальные склады — схема.md в argus-product).
//
// Виртуальный склад — часть товара продавца на живом складе, отложенная под
// своё назначение: площадку (Озон, Яндекс Маркет, WB), юрлицо, «иное».
// Физически товар лежит в тех же ячейках; меняется учёт.
//
// «Основной склад» строкой не хранится: это NULL в virtual_warehouse_id. Так
// весь товар, что лежит сейчас, уже на «Основном», и переносить при запуске
// ничего не нужно. «Склад брака» — тоже не строка: брак — это cell_stock с
// состоянием «брак», а склад он помнит своей отметкой.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE virtual_warehouses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
      -- Для какой площадки: поставку на WB можно собрать только с «Основного»
      -- и со складов WB (вопросы 10–11).
      marketplace TEXT NOT NULL CHECK (marketplace IN ('wb', 'ozon', 'yandex', 'other')),
      -- «Хранить отдельно» (вопрос 7): товар этого склада не лежит в одной
      -- ячейке с товаром других складов.
      keep_separate BOOLEAN NOT NULL DEFAULT false,
      created_by UUID,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      archived_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX virtual_warehouses_name ON virtual_warehouses (company_id, lower(btrim(name)))
      WHERE archived_at IS NULL;
    CREATE INDEX virtual_warehouses_company ON virtual_warehouses (company_id);

    -- Чей товар в строке остатка; NULL — «Основной». У брака — склад, с
    -- которого он пришёл.
    ALTER TABLE cell_stock ADD COLUMN virtual_warehouse_id UUID REFERENCES virtual_warehouses(id);
    CREATE INDEX idx_cell_stock_company_sku_vw ON cell_stock (company_id, sku, virtual_warehouse_id);
    -- На какой склад принимают строку привоза, с какого собирают строку
    -- заказа (заказ в поставке берёт склад поставки), куда возвращают.
    ALTER TABLE invoice_items ADD COLUMN virtual_warehouse_id UUID REFERENCES virtual_warehouses(id);
    -- С какого склада собирается поставка (вопрос 3: только с одного).
    ALTER TABLE supplies ADD COLUMN virtual_warehouse_id UUID REFERENCES virtual_warehouses(id);
    -- С какого склада пришёл брак — в документе склада брака.
    ALTER TABLE defect_moves ADD COLUMN virtual_warehouse_id UUID REFERENCES virtual_warehouses(id);

    -- «Права склада» в кабинете продавца (вопрос 14): что склад может делать
    -- с товаром продавца без его согласия. Нет ключа — право есть (так по
    -- умолчанию у каждого нового продавца).
    ALTER TABLE companies ADD COLUMN ff_rights JSONB NOT NULL DEFAULT '{}'::jsonb;

    -- Перенос товара между складами: склад делает сам (продавцу уведомление),
    -- продавец — только заявкой (вопрос 8). requested — заявка продавца ждёт
    -- склада; waiting_seller — склад просит, а у продавца право отключено;
    -- to_move — склад «хранить отдельно», грузчик перекладывает; done;
    -- rejected.
    CREATE TABLE vw_transfers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      number TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT,
      qty NUMERIC NOT NULL CHECK (qty > 0 AND qty = trunc(qty)),
      from_vw UUID REFERENCES virtual_warehouses(id),
      to_vw UUID REFERENCES virtual_warehouses(id),
      note TEXT CHECK (note IS NULL OR length(note) <= 300),
      status TEXT NOT NULL CHECK (status IN ('requested', 'waiting_seller', 'to_move', 'done', 'rejected')),
      requested_role TEXT NOT NULL CHECK (requested_role IN ('seller', 'owner', 'manager')),
      requested_by UUID,
      requested_name TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_role TEXT CHECK (decided_role IN ('seller', 'owner', 'manager')),
      decided_by UUID,
      decided_name TEXT,
      decided_at TIMESTAMPTZ,
      reject_reason TEXT CHECK (reject_reason IS NULL OR length(reject_reason) <= 300),
      done_at TIMESTAMPTZ,
      done_by UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      done_name TEXT,
      moved_cells JSONB,
      CHECK (from_vw IS DISTINCT FROM to_vw),
      UNIQUE (warehouse_id, number)
    );
    CREATE INDEX vw_transfers_company ON vw_transfers (company_id, requested_at DESC);
    CREATE INDEX vw_transfers_open ON vw_transfers (warehouse_id, status) WHERE status IN ('requested', 'waiting_seller', 'to_move');

    -- Уведомления продавцу в кабинете (почты нет): склад перенёс товар,
    -- списал недостачу, выполнил заявку… seen_at — продавец нажал «Понятно».
    CREATE TABLE seller_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      text TEXT NOT NULL CHECK (length(text) <= 1000),
      entity_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      seen_at TIMESTAMPTZ
    );
    CREATE INDEX seller_notifications_unseen ON seller_notifications (company_id, created_at DESC) WHERE seen_at IS NULL;

    ALTER TABLE virtual_warehouses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON virtual_warehouses USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
    ALTER TABLE vw_transfers ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON vw_transfers USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
    ALTER TABLE seller_notifications ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON seller_notifications USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON virtual_warehouses, vw_transfers, seller_notifications TO argus_app;
    END IF; END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS seller_notifications;
    DROP TABLE IF EXISTS vw_transfers;
    ALTER TABLE companies DROP COLUMN IF EXISTS ff_rights;
    ALTER TABLE defect_moves DROP COLUMN IF EXISTS virtual_warehouse_id;
    ALTER TABLE supplies DROP COLUMN IF EXISTS virtual_warehouse_id;
    ALTER TABLE invoice_items DROP COLUMN IF EXISTS virtual_warehouse_id;
    DROP INDEX IF EXISTS idx_cell_stock_company_sku_vw;
    ALTER TABLE cell_stock DROP COLUMN IF EXISTS virtual_warehouse_id;
    DROP TABLE IF EXISTS virtual_warehouses;
  `);
};
