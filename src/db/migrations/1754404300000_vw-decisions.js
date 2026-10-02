/* eslint-disable camelcase */
// Спорные ситуации с количеством у складов продавца (владелец 02.10.2026):
// не хватило товара при пересчёте, нашлось лишнее, приняли не столько,
// сколько заявили на разные склады, брак с полки, где лежит товар разных
// складов. Учёт сразу записывается по правилу склада; если продавец
// запретил складу решать без него — решение ждёт продавца здесь.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE vw_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('inventory', 'receiving', 'defect')),
      sku TEXT NOT NULL,
      name TEXT,
      quality TEXT NOT NULL DEFAULT 'good',
      title TEXT NOT NULL CHECK (length(title) <= 500),
      -- [{ vw, before, value, min, max }]: сколько было, как записано по
      -- правилу и в каких пределах продавец может поменять.
      parts JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'changed')),
      chosen JSONB,
      transfers JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ,
      decided_by UUID
    );
    CREATE INDEX vw_decisions_open ON vw_decisions (company_id, created_at DESC) WHERE status = 'pending';

    -- Перенос по решению продавца бывает и браком (кто понёс брак).
    ALTER TABLE vw_transfers ADD COLUMN quality TEXT NOT NULL DEFAULT 'good';

    ALTER TABLE vw_decisions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON vw_decisions USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON vw_decisions TO argus_app;
    END IF; END $$;

    -- Одно право вместо двух (владелец 02.10.2026): «решать спорные
    -- ситуации с количеством без продавца».
    UPDATE companies SET ff_rights = jsonb_build_object('decide', false)
     WHERE ff_rights->>'transfer' = 'false' OR ff_rights->>'shortage' = 'false';
    UPDATE companies SET ff_rights = '{}'::jsonb WHERE ff_rights <> '{}'::jsonb AND NOT ff_rights ? 'decide';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE vw_transfers DROP COLUMN IF EXISTS quality;
    DROP TABLE IF EXISTS vw_decisions;
  `);
};
