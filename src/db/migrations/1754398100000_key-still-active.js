/* eslint-disable camelcase */

exports.shorthands = undefined;

// Проверка «ключ ещё действует» — по идентификатору, а не по коду.
//
// Отзыв ключа до сих пор закрывал только вход: выданный ранее токен жил своей
// жизнью до конца срока (45 минут). То есть «отозвать ключ уволенному» на самом
// деле означало «он поработает ещё три четверти часа» — а отзывают ключ обычно
// именно тогда, когда этих минут и нет.
//
// SECURITY DEFINER и максимально узкий ответ — один булев флаг. Функция
// вызывается до того, как известен контекст склада (собственно, чтобы решить,
// пускать ли вообще), поэтому обычный SELECT здесь вернул бы ноль строк из-за
// изоляции — та же ловушка, что уже ломала обход тревог.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION staff_key_is_active(p_id UUID)
    RETURNS BOOLEAN
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      SELECT COALESCE((SELECT active FROM staff_keys WHERE id = p_id), false);
    $$;

    CREATE OR REPLACE FUNCTION seller_key_is_active(p_id UUID)
    RETURNS BOOLEAN
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      SELECT COALESCE((SELECT active FROM seller_keys WHERE id = p_id), false);
    $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT EXECUTE ON FUNCTION staff_key_is_active(UUID) TO argus_app;
        GRANT EXECUTE ON FUNCTION seller_key_is_active(UUID) TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS staff_key_is_active(UUID);
    DROP FUNCTION IF EXISTS seller_key_is_active(UUID);
  `);
};
