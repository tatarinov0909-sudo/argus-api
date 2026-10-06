/* eslint-disable camelcase */

exports.shorthands = undefined;

// Адресное хранение — настройка склада (владелец 06.10.2026). Выключено:
// товар лежит в одном общем месте «Склад» (ряд 0, одна ячейка с отметкой
// general), ячейки не выбирают ни при приёмке, ни при сборке. Включат снова,
// когда будет схема склада после инвентаризации; товар до раскладки остаётся
// в «Складе».
//
// Сборка сверх учёта при выключенном хранении уводит «Склад» в минус —
// владелец поправит. В обычной ячейке минуса по-прежнему нет: проверку
// cell_stock_qty_nonneg заменяет триггер, разрешающий минус только «Складу».
// Он же — страховка: при выключенном хранении товар, который любой путь
// пытается положить в ячейку, ложится в «Склад».
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE warehouses ADD COLUMN address_storage BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE cell_blocks ADD COLUMN general BOOLEAN NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX cell_blocks_one_general ON cell_blocks (warehouse_id) WHERE general;

    ALTER TABLE cell_stock DROP CONSTRAINT cell_stock_qty_nonneg;

    CREATE FUNCTION cell_stock_place() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE
      general_id uuid;
    BEGIN
      IF EXISTS (SELECT 1 FROM warehouses w WHERE w.id = NEW.warehouse_id AND NOT w.address_storage) THEN
        SELECT cb.id INTO general_id FROM cell_blocks cb WHERE cb.warehouse_id = NEW.warehouse_id AND cb.general;
        IF general_id IS NOT NULL THEN
          NEW.cell_block_id := general_id;
        END IF;
      END IF;
      IF NEW.qty < 0 AND NOT EXISTS (SELECT 1 FROM cell_blocks cb WHERE cb.id = NEW.cell_block_id AND cb.general) THEN
        RAISE EXCEPTION 'В ячейке не может быть меньше нуля' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER cell_stock_place BEFORE INSERT OR UPDATE OF cell_block_id, qty ON cell_stock
      FOR EACH ROW EXECUTE FUNCTION cell_stock_place();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS cell_stock_place ON cell_stock;
    DROP FUNCTION IF EXISTS cell_stock_place();
    ALTER TABLE cell_stock ADD CONSTRAINT cell_stock_qty_nonneg CHECK (qty >= 0) NOT VALID;
    DROP INDEX IF EXISTS cell_blocks_one_general;
    ALTER TABLE cell_blocks DROP COLUMN IF EXISTS general;
    ALTER TABLE warehouses DROP COLUMN IF EXISTS address_storage;
  `);
};
