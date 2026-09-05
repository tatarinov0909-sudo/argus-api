/* eslint-disable camelcase */

exports.shorthands = undefined;

// Имя ячейки так, как оно написано на стеллаже.
//
// До сих пор Аргус собирал подпись из координат: «ряд 1, стеллаж 15, ярус 2».
// Для склада, нарисованного в конструкторе, это верно — других имён там нет.
// Но у владельца ячейки названы в 1С («01-10-015»), и на полке висит именно
// эта табличка. Пересчитывать её в свои координаты значит заставить человека
// переводить в уме, а работника — искать полку по цифрам, которых он нигде
// не видит.
//
// Отдельная колонка, а не переименование координат: координаты остаются
// геометрией (где рисовать на карте), имя — тем, что читает глазами человек.
// Их нельзя склеивать ещё и потому, что ярус 10 у этого склада физически
// стоит между первым и вторым: на карте он второй снизу, а называется 10.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE cell_blocks ADD COLUMN IF NOT EXISTS label TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cell_blocks_label
      ON cell_blocks(warehouse_id, label) WHERE label IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS idx_cell_blocks_label; ALTER TABLE cell_blocks DROP COLUMN IF EXISTS label;');
};
