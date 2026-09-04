/* eslint-disable camelcase */

exports.shorthands = undefined;

// Ключ доступа к площадке принадлежит продавцу, а хранить его будет склад. Это
// не пароль от нашего кабинета: им можно читать чужие заказы и менять чужой
// остаток. Поэтому в базе он лежит только зашифрованным (AES-GCM на уровне
// приложения, ключ из переменной окружения) — здесь только место под шифртекст,
// разбирать его база не умеет и не должна.
//
// write_enabled — единственный переключатель вместо «версии только на чтение».
// Формулировка про read-only была нечестной: ключ, который отдаёт продавец,
// писать умеет, ограничение живёт в нашем коде, а не в ключе. Флаг делает это
// ограничение явным и снимаемым по одному продавцу.
//
// warehouse_id есть, хотя компания уже указывает на склад: вся изоляция в
// проекте построена на нём, и политика должна выглядеть как везде.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE marketplace_credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      marketplace TEXT NOT NULL,
      -- Шифртекст целиком: у площадок разный состав доступа (у одной токен,
      -- у другой пара «клиент + ключ», у третьей кампания), и раскладывать это
      -- по колонкам значит хранить часть открытым текстом.
      encrypted_payload TEXT NOT NULL,
      -- Запись на площадку выключена по умолчанию: неделя на проверку связи,
      -- потом включаем на одном небольшом продавце.
      write_enabled BOOLEAN NOT NULL DEFAULT false,
      -- Когда ключ последний раз сработал. Молчание интеграции — самая тихая
      -- поломка из возможных, и отличить её от затишья можно только отметкой.
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Один ключ на пару «продавец + площадка». Второй ключ той же пары означал
    -- бы, что неизвестно, каким из них мы сейчас работаем.
    CREATE UNIQUE INDEX idx_mp_credentials_pair
      ON marketplace_credentials(company_id, marketplace);

    ALTER TABLE marketplace_credentials ENABLE ROW LEVEL SECURITY;
    -- Продавец сюда НЕ допущен намеренно, в отличие от остальных таблиц:
    -- ключ отдаётся складу, и показывать его обратно через кабинет незачем —
    -- это лишняя дверь к чужому доступу.
    CREATE POLICY tenant_isolation ON marketplace_credentials USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_credentials TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS marketplace_credentials CASCADE;`);
};
