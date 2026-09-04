/* eslint-disable camelcase */

exports.shorthands = undefined;

// Сторожу тревог нужно обойти ВСЕ склады — это первое в проекте, что работает
// не по запросу человека, а само по себе, и поэтому не имеет контекста склада.
//
// Обычный SELECT из warehouses в такой ситуации возвращает ноль строк и не
// ругается: RLS отфильтровывает всё, раз контекст не задан. Именно на этом
// проход и молчал в проде — «проверено складов: 0», без единой ошибки в логе.
//
// Тот же приём, что уже применён для входа по ключам (см. миграции
// 300000/400000/500000): узкая SECURITY DEFINER функция, которая умеет ровно
// одно и не отдаёт ничего лишнего — только идентификаторы, без имён, городов
// и владельцев.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION list_warehouse_ids_for_alerts()
    RETURNS TABLE(id UUID)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT id FROM warehouses ORDER BY created_at;
    $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT EXECUTE ON FUNCTION list_warehouse_ids_for_alerts() TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS list_warehouse_ids_for_alerts();`);
};
