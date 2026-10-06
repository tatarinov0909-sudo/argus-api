// Как называется ячейка на бумаге и в ответе агента.
//
// Одна функция на всех, потому что адрес, произнесённый Кладовщиком, и адрес,
// напечатанный в листе комплектации, обязаны совпадать буква в букву. Две
// копии этой логики разъедутся на первой же правке, и работник получит
// «01-10-015» в одном месте и «1.10.15» в другом.
//
// Адрес — «ряд.стеллаж.ярус» (решение владельца 27.09.2026, рисунок: по
// горизонтали стеллажи 1, 2, 3…, по вертикали ярусы 1…6, ячейка — их
// пересечение). «1.7.3» — ряд 1, стеллаж 7, ярус 3. До 27.09 адрес писался
// «ряд.ярус.ячейка», и та же ячейка была подписана «1.3.7».
//
// Имя ячейки из 1С («01-01-001») не показываем: оно не совпадает с картой, и
// человек его не понимает. Оно остаётся в базе только для сверки с файлами 1С.
// Ряд 0 — общее место «Склад» при выключенном адресном хранении
// (src/cells/addressing.js, владелец 06.10.2026).
function formatBlockLabel(rowNum, block) {
  if (Number(rowNum) === 0) return 'Склад';
  const rackPart = block.rack_start === block.rack_end
    ? block.rack_start : `${block.rack_start}–${block.rack_end}`;
  const tierPart = block.tier_start === block.tier_end
    ? block.tier_start : `${block.tier_start}–${block.tier_end}`;
  return `${rowNum}.${rackPart}.${tierPart}`;
}

// То же самое в SQL — для запросов, которые отдают адрес строкой (журнал,
// история ячейки): собирать его в JS ради подписи значило бы тянуть карту.
// cb — cell_blocks, wr — warehouse_rows.
function blockLabelSql(cb = 'cb', wr = 'wr') {
  return `(CASE WHEN ${wr}.row_num = 0 THEN 'Склад' ELSE ${wr}.row_num
      || '.' || CASE WHEN ${cb}.rack_start = ${cb}.rack_end THEN ${cb}.rack_start::text
                     ELSE ${cb}.rack_start || '–' || ${cb}.rack_end END
      || '.' || CASE WHEN ${cb}.tier_start = ${cb}.tier_end THEN ${cb}.tier_start::text
                     ELSE ${cb}.tier_start || '–' || ${cb}.tier_end END END)`;
}

module.exports = { formatBlockLabel, blockLabelSql };
