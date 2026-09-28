/* eslint-disable camelcase */

exports.shorthands = undefined;

// Раскладка приёмки по шагам (задание 28.09.2026, п. 1). Укладка больше не
// «сколько лежит в ячейке», а шаг: «положил N шт. в ячейку X» (kind put,
// qty > 0) или «забрал N шт. из ячейки X» (kind take, qty < 0). Сколько
// товара позиции лежит в ячейке — сумма её шагов по этой ячейке.
//
// Так «Переложить» — это два шага (забрал из A, положил в B; у второго
// pair_id — первый), «Убрать из ячейки» — один шаг «забрал». Каждый шаг потом
// подтвердят сканом: QR ячейки → QR товара → количество (confirmed_*), а
// «забрал» — сканом ячейки. Поэтому шаги не склеиваются и одна ячейка в
// одной позиции может встречаться сколько угодно раз.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE receiving_placements DROP CONSTRAINT receiving_placements_qty_check;
    ALTER TABLE receiving_placements
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'put' CHECK (kind IN ('put', 'take')),
      ADD COLUMN pair_id UUID REFERENCES receiving_placements(id) ON DELETE SET NULL,
      ADD CONSTRAINT receiving_placements_qty_sign CHECK ((kind = 'put' AND qty > 0) OR (kind = 'take' AND qty < 0));
    DROP INDEX receiving_placements_one_cell;
    CREATE INDEX receiving_placements_record_cell ON receiving_placements (receiving_record_id, cell_block_id);
  `);
};

// Назад — к «строке на ячейку»: у каждой пары (позиция, ячейка) остаётся её
// первый шаг с итоговым количеством, пустые ячейки уходят. История шагов при
// этом теряется, раскладка — нет.
exports.down = (pgm) => {
  pgm.sql(`
    CREATE TEMP TABLE rp_net ON COMMIT DROP AS
      SELECT (array_agg(id ORDER BY step))[1] AS keep_id, SUM(qty) AS net
        FROM receiving_placements GROUP BY receiving_record_id, cell_block_id;
    ALTER TABLE receiving_placements DROP CONSTRAINT receiving_placements_qty_sign;
    UPDATE receiving_placements SET pair_id = NULL;
    DELETE FROM receiving_placements rp
     WHERE NOT EXISTS (SELECT 1 FROM rp_net n WHERE n.keep_id = rp.id AND n.net > 0);
    UPDATE receiving_placements rp SET qty = n.net, kind = 'put' FROM rp_net n WHERE n.keep_id = rp.id;
    DROP INDEX receiving_placements_record_cell;
    ALTER TABLE receiving_placements DROP COLUMN pair_id, DROP COLUMN kind;
    ALTER TABLE receiving_placements ADD CONSTRAINT receiving_placements_qty_check CHECK (qty > 0);
    CREATE UNIQUE INDEX receiving_placements_one_cell
      ON receiving_placements (receiving_record_id, cell_block_id) WHERE cell_block_id IS NOT NULL;
  `);
};
