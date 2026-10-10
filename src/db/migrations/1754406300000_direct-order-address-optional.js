/* eslint-disable camelcase */

exports.shorthands = undefined;

// Адрес у заказа физлицу — необязательный (владелец 10.10.2026: «поставка
// может формироваться без адреса доставки»): продавец забирает сам, адрес
// уточнят позже. Пустой адрес — NULL, а не пустая строка.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE direct_orders ALTER COLUMN address DROP NOT NULL;
    UPDATE direct_orders SET address = NULL WHERE btrim(address) = '';
  `);
};

// Обратно — только если адресов без значения нет: иначе откат молча
// придумал бы адрес.
exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM direct_orders WHERE address IS NULL) THEN
        RAISE EXCEPTION 'Есть заказы физлицам без адреса — откат не выполнен';
      END IF;
    END $$;
    ALTER TABLE direct_orders ALTER COLUMN address SET NOT NULL;
  `);
};
