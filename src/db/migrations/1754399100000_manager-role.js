/* eslint-disable camelcase */

exports.shorthands = undefined;

// Менеджер — четвёртый человек в системе.
//
// Заводится НЕ отдельной таблицей, а видом ключа сотрудника: вход по ключу,
// отзыв в одну секунду, проверка живости ключа на каждом запросе — всё это
// у работников уже работает и проверено. Своя таблица означала бы второй
// такой же вход, который придётся починить дважды при первой же правке.
//
// Урезание менеджера — значение по умолчанию, а не бетон: у одного
// фулфилмента менеджер сам заводит клиентов, у другого к деньгам его не
// подпустят. Поэтому список открытых прав лежит на самом ключе и по
// умолчанию пуст.
//
// Одно право не открывается никому, кроме владельца, и его нет в списке
// сознательно: выдача ключей самим менеджерам. Иначе менеджер выпишет себе
// полный доступ, и урезание превратится в вежливую просьбу.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE staff_kind AS ENUM ('worker', 'manager');

    ALTER TABLE staff_keys
      ADD COLUMN IF NOT EXISTS kind staff_kind NOT NULL DEFAULT 'worker',
      ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}';
  `);

  // Функция входа отдаёт вид ключа и права: без них токен не отличит
  // менеджера от работника, а проверять их отдельным запросом до знания
  // склада нельзя — RLS ещё не включена.
  pgm.sql(`
    DROP FUNCTION IF EXISTS find_staff_key_for_login(TEXT);
    CREATE FUNCTION find_staff_key_for_login(p_key_code TEXT)
    RETURNS TABLE(id UUID, warehouse_id UUID, name TEXT, active BOOLEAN,
                  kind staff_kind, permissions TEXT[])
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT id, warehouse_id, name, active, kind, permissions
      FROM staff_keys WHERE key_code = p_key_code;
    $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT EXECUTE ON FUNCTION find_staff_key_for_login(TEXT) TO argus_app;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS find_staff_key_for_login(TEXT);
    CREATE FUNCTION find_staff_key_for_login(p_key_code TEXT)
    RETURNS TABLE(id UUID, warehouse_id UUID, name TEXT, active BOOLEAN)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT id, warehouse_id, name, active FROM staff_keys WHERE key_code = p_key_code;
    $$;
    ALTER TABLE staff_keys DROP COLUMN IF EXISTS permissions, DROP COLUMN IF EXISTS kind;
    DROP TYPE IF EXISTS staff_kind;
  `);
};
