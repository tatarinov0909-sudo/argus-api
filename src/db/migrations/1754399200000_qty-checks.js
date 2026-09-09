/* eslint-disable camelcase */

exports.shorthands = undefined;

// Ограничения на количества в самых старых таблицах.
//
// У возвратов, резервов, наборов и перемещений `CHECK (qty > 0)` стоял с
// самого начала. У накладных, приёмки и остатка в ячейке — нет: это первые
// таблицы схемы, и тогда до этого не дошли. В результате база принимала
// минус пятьсот в приёмку, то есть тихое списание чужого товара с полки, и
// ноль в позицию накладной, то есть строку, которую нельзя собрать и не видно
// в сумме.
//
// Проверка есть и в коде (`middleware/qty.js`), но код — это то, что можно
// обойти следующим маршрутом, написанным иначе. База — то, что нельзя.
//
// Живые данные проверены перед добавлением: ни одной отрицательной, нулевой
// или дробной величины на складе нет, поэтому ограничения встают без правки
// истории.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoice_items
      ADD CONSTRAINT invoice_items_declared_qty_positive CHECK (declared_qty > 0);

    -- Ноль здесь законен: «привезли ноль» — это факт приёмки, а не ошибка.
    ALTER TABLE receiving_records
      ADD CONSTRAINT receiving_records_accepted_qty_nonneg CHECK (accepted_qty >= 0);

    -- Остаток в ячейке ниже нуля не бывает физически. Если такая запись
    -- когда-нибудь появится, это ошибка в отборе, и узнать о ней надо
    -- в момент записи, а не через месяц по расхождению.
    ALTER TABLE cell_stock
      ADD CONSTRAINT cell_stock_qty_nonneg CHECK (qty >= 0);
  `);

  // Таблица адресов из 1С появилась позже и могла не существовать
  // в окружении, где эту миграцию накатывают на старую базу.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'product_cells_1c') THEN
        ALTER TABLE product_cells_1c
          ADD CONSTRAINT product_cells_1c_qty_nonneg CHECK (qty >= 0);
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoice_items DROP CONSTRAINT IF EXISTS invoice_items_declared_qty_positive;
    ALTER TABLE receiving_records DROP CONSTRAINT IF EXISTS receiving_records_accepted_qty_nonneg;
    ALTER TABLE cell_stock DROP CONSTRAINT IF EXISTS cell_stock_qty_nonneg;
    ALTER TABLE product_cells_1c DROP CONSTRAINT IF EXISTS product_cells_1c_qty_nonneg;
  `);
};
