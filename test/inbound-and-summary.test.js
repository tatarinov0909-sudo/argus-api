// Поломки 30.09.2026: акт приёмки склада без строк товара отклонялся словами
// «не нашёл колонку» (колонки есть — нет строк); «Всего товара» у продавца
// становилось прочерком из-за одного товара, которого нет в учёте.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInboundSheet } = require('../src/sellers/inbound');
const { sellerStockResponse } = require('../src/sellers/routes');

// «Акт приемки на хранение» склада: шапка документа, таблица с 9-й строки,
// «ИТОГО» внизу.
const act = (rows) => [
  ['Акт приемки на хранение № ____'], [], ['Хранитель: ООО Александрия'], ['Поклажедатель (юр. лицо): '],
  ['СКЛАД: '], [], ['Дата приемки на ОХ:'], [],
  ['№ ', 'Артикул', 'ШК', 'Номенклатура', 'Кол-во шт', 'Кол-во коробов', 'Кол-во палет'],
  ...rows,
  [null, null, null, 'ИТОГО', 0, 0, 0],
];

test('пустой акт: честно «нет строк с товаром», а не «не нашёл колонку»', () => {
  assert.throws(() => parseInboundSheet(act([[], [], []])), /нет ни одной строки с товаром/);
});

test('заполненный акт склада разбирается: артикул, ШК, название, штуки; коробы — не штуки', () => {
  const lines = parseInboundSheet(act([
    [1, 'PB000021145', '4600000000017', 'Пояс утягивающий L', 40, 2, 0],
    [2, 'PB000021146', 4600000000024, 'Пояс утягивающий M', '12 шт', 1, 0],
  ]));
  assert.deepEqual(lines.map((l) => [l.article, l.barcode, l.name, l.qty]), [
    ['PB000021145', '4600000000017', 'Пояс утягивающий L', 40],
    ['PB000021146', '4600000000024', 'Пояс утягивающий M', 12],
  ]);
});

test('«Всего» и «Доступно» — по товарам с учётом; неизвестные названы, а не прячут всё число', () => {
  const row = (sku, name, total, available) => ({
    sku, name, listed: true, totalKnown: total != null, total, sellerAvailable: available,
    orderedNotInSupply: 0, inAssembly: 0, inTransit: 0, defective: 0, packagingDefect: 0,
  });
  const out = sellerStockResponse([
    row('A', 'Батончик', 100, 90), row('B', 'Паста', 50, 50), row('T', 'ТЕСТ Батончик Кокос', null, null),
  ]);
  assert.equal(out.summary.total, 150);
  assert.equal(out.summary.available, 140);
  assert.equal(out.summary.unknownCount, 1);
  assert.deepEqual(out.summary.unknownNames, ['ТЕСТ Батончик Кокос']);
  const none = sellerStockResponse([row('T', 'Тест', null, null)]);
  assert.equal(none.summary.total, null);   // не знаем ни одного — прочерк
});
