/* eslint-disable camelcase */

exports.shorthands = undefined;

// Смена пароля владельцем из кабинета (аудит 30.09.2026: забытый или
// утёкший пароль нельзя было сменить без разработчика). Таблица owners
// по-прежнему закрыта: одна узкая функция проверяет старый хеш и ставит
// новый — атомарно, только если старый совпал.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION owner_password_hash(p_owner_id UUID)
    RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT password_hash FROM owners WHERE id = p_owner_id;
    $$;
    CREATE OR REPLACE FUNCTION set_owner_password(p_owner_id UUID, p_old_hash TEXT, p_new_hash TEXT)
    RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      WITH u AS (UPDATE owners SET password_hash = p_new_hash
                  WHERE id = p_owner_id AND password_hash = p_old_hash RETURNING 1)
      SELECT EXISTS (SELECT 1 FROM u);
    $$;
  `);
  pgm.sql(`
    DO $$
    BEGIN
      REVOKE ALL ON FUNCTION owner_password_hash(UUID) FROM PUBLIC;
      REVOKE ALL ON FUNCTION set_owner_password(UUID, TEXT, TEXT) FROM PUBLIC;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT EXECUTE ON FUNCTION owner_password_hash(UUID) TO argus_app;
        GRANT EXECUTE ON FUNCTION set_owner_password(UUID, TEXT, TEXT) TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS set_owner_password(UUID, TEXT, TEXT);
    DROP FUNCTION IF EXISTS owner_password_hash(UUID);
  `);
};
