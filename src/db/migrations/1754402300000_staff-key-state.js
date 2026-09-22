// Роль и права ключа сотрудника — на каждый запрос, из базы, а не из токена.
//
// Вход теперь живёт смену и продлевается сам (владелец 22.09: «вылетает
// каждые 45 минут»). Раньше права менеджера и роль ключа читались из токена
// — и снятое право или «обратно в работники» действовали бы до конца его
// жизни. Функция отдаёт то, что есть сейчас. SECURITY DEFINER — по той же
// причине, что staff_key_is_active: вызывается до того, как известен склад.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION staff_key_state(p_id UUID)
    RETURNS TABLE (active BOOLEAN, kind TEXT, permissions TEXT[])
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      SELECT active, kind::text, permissions FROM staff_keys WHERE id = p_id;
    $$;
  `);
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT EXECUTE ON FUNCTION staff_key_state(UUID) TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS staff_key_state(UUID);`);
};
