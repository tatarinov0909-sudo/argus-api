/* eslint-disable camelcase */
// Отозванный ключ обмена с 1С перестаёт работать на любом пути, а не только
// в обмене (проверка 03.10.2026: токен отозванного ключа ещё до двух часов
// читал товары и накладные склада). Тот же узкий ответ, что у ключей
// сотрудников и продавцов, — один флаг.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION integration_key_is_active(p_id UUID)
    RETURNS BOOLEAN
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      SELECT COALESCE((SELECT active FROM integration_keys WHERE id = p_id), false);
    $$;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT EXECUTE ON FUNCTION integration_key_is_active(UUID) TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP FUNCTION IF EXISTS integration_key_is_active(UUID);');
};
