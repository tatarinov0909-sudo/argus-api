/* eslint-disable camelcase */

exports.shorthands = undefined;

// Свои имена для рядов и зон.
//
// На складе ряды зовут по-своему — «А», «Б1», «К12» — и работник ищет то имя,
// которое слышит вслух, а не порядковый номер из нашей нумерации.
//
// Имя ряда становится первой частью адреса ячейки: было `1.3.4`, стало
// `А.3.4`. Этот адрес человек читает вслух, вводит в поиск и диктует по рации,
// поэтому имя обязано быть коротким — длину ограничивает API четырьмя
// символами. По той же причине имена обязаны быть уникальными внутри склада:
// два ряда с именем «А» сделали бы адреса неоднозначными, и Кладовщик начал бы
// путать ячейки. Уникальность стоит здесь, в базе, а не только в API — это
// единственное место, где её нельзя обойти гонкой двух одновременных запросов.
//
// NULL значит «имени нет, показываем номер». Отсюда частичный индекс: пустых
// имён может быть сколько угодно, занятых — по одному.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE warehouse_rows ADD COLUMN IF NOT EXISTS label TEXT;

    -- Сравнение без учёта регистра: «а» и «А» для человека один и тот же ряд,
    -- и разрешить оба — значит позволить две разные ячейки с одним адресом.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouse_rows_label
      ON warehouse_rows (warehouse_id, lower(label))
      WHERE label IS NOT NULL;

    -- У зон поле label уже было, но хранило автоматическое «Зона 1» — это не
    -- выбор владельца, а заглушка, и она длиннее разрешённых четырёх символов.
    -- Обнуляем такие значения: показываться будет номер, пока имя не задали.
    -- Для этого снимаем NOT NULL: пустое имя теперь законное состояние, а не
    -- пропущенные данные.
    ALTER TABLE dropzones ALTER COLUMN label DROP NOT NULL;
    UPDATE dropzones SET label = NULL WHERE label ~ '^Зона [0-9]+$';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_dropzones_label
      ON dropzones (warehouse_id, lower(label))
      WHERE label IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_dropzones_label;
    DROP INDEX IF EXISTS idx_warehouse_rows_label;
    ALTER TABLE warehouse_rows DROP COLUMN IF EXISTS label;
    -- Вернуть NOT NULL можно только заполнив пустые имена обратно.
    UPDATE dropzones SET label = 'Зона ' || zone_num WHERE label IS NULL;
    ALTER TABLE dropzones ALTER COLUMN label SET NOT NULL;
  `);
};
