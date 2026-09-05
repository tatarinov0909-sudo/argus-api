/* eslint-disable camelcase */

exports.shorthands = undefined;

// Учётки владельцев закрываем от приложения.
//
// `owners` была единственной таблицей с данными без изоляции вообще, и роль
// приложения могла прочитать её целиком — вместе с хешами паролей и почтой всех
// владельцев. Сегодня ни одна ручка этого не делает, но защита, которая держится
// на «никто пока не написал такой запрос», защитой не является: одна неудачная
// правка или одна инъекция — и утекает всё сразу.
//
// Дальше по проекту это решается одинаково: узкая SECURITY DEFINER функция
// делает ровно одно действие, а сама таблица закрыта. Тот же приём, что у
// find_seller_key_for_login и find_staff_key_for_login.
exports.up = (pgm) => {
  pgm.sql(`
    -- Вход: одна почта — одна строка. Регистр не важен, потому что почта для
    -- человека одно и то же в любом регистре.
    CREATE OR REPLACE FUNCTION find_owner_for_login(p_email TEXT)
    RETURNS TABLE (id UUID, name TEXT, email TEXT, password_hash TEXT)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      SELECT o.id, o.name, o.email, o.password_hash
      FROM owners o
      WHERE lower(o.email) = lower(trim(p_email))
      LIMIT 1;
    $$;

    -- Регистрация: создать владельца и сразу вернуть его, не открывая таблицу.
    -- Занятая почта возвращается как есть — обработать её должен вызывающий,
    -- ему виднее, что сказать человеку.
    CREATE OR REPLACE FUNCTION create_owner(p_name TEXT, p_email TEXT, p_hash TEXT)
    RETURNS TABLE (id UUID, name TEXT, email TEXT)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      INSERT INTO owners (name, email, password_hash)
      VALUES (p_name, lower(trim(p_email)), p_hash)
      RETURNING owners.id, owners.name, owners.email;
    $$;

    -- Приведём уже записанные адреса к одному виду: иначе вход по почте с
    -- заглавной буквы работает, а по строчной — нет, и наоборот.
    UPDATE owners SET email = lower(trim(email)) WHERE email <> lower(trim(email));

    -- Сама таблица закрыта: RLS включена, политик нет — значит запрещено всё.
    -- Функции выше работают от владельца функции и изоляцию не видят.
    ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        REVOKE ALL ON owners FROM argus_app;
        GRANT EXECUTE ON FUNCTION find_owner_for_login(TEXT) TO argus_app;
        GRANT EXECUTE ON FUNCTION create_owner(TEXT, TEXT, TEXT) TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE owners DISABLE ROW LEVEL SECURITY;
    DROP FUNCTION IF EXISTS find_owner_for_login(TEXT);
    DROP FUNCTION IF EXISTS create_owner(TEXT, TEXT, TEXT);
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON owners TO argus_app;
      END IF;
    END
    $$;
  `);
};
