const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', '1c-module', 'СинхронизацияАргус.bsl'),
  'utf8',
);

test('1C module does not route every warehouse row into a hard-coded seller', () => {
  assert.doesNotMatch(source, /defaultCompanyName/);
  assert.doesNotMatch(source, /HappyLand Test/);
});

test('1C module stages counterparties and carries stable product ids', () => {
  assert.match(source, /\/api\/sync\/push\/counterparties/);
  assert.ok((source.match(/productExternalId/g) || []).length >= 3);
});

test('1C stock query includes zero balances', () => {
  assert.match(source, /ЛЕВОЕ СОЕДИНЕНИЕ РегистрНакопления/);
  assert.match(source, /ЕСТЬNULL\(СУММА\(Остатки\.КоличествоОстаток\), 0\)/);
  assert.doesNotMatch(source, /СУММА\(Остатки\.КоличествоОстаток\) <> 0/);
});

function block(name, kind = 'Функция') {
  const ending = kind === 'Функция' ? 'КонецФункции' : 'КонецПроцедуры';
  const match = source.match(new RegExp(`${kind} ${name}\\([^]*?${ending}`));
  assert.ok(match, `${kind} ${name} exists`);
  return match[0];
}

test('scheduled exchange never logs its launch key and always records completion', () => {
  const startup = block('ПриОткрытии', 'Процедура');
  assert.doesNotMatch(startup, /ЗаписьЖурнала\([^\r\n]*ПараметрЗапуска/);
  assert.match(startup, /Исключение[^]*Завершение автообмена/);
  const journal = block('ЗаписьЖурнала', 'Процедура');
  assert.match(journal, /КаталогВременныхФайлов\(\)/);
  assert.doesNotMatch(journal, /C:\\Users\\/);
  assert.match(journal, /СтрЗаменить\(БезопасныйТекст, СокрЛП\(КлючИнтеграции\)/);
  assert.match(journal, /СтрЗаменить\(БезопасныйТекст, мТокенДоступа/);
});

test('failed reserve reads cannot be mistaken for a confirmed zero snapshot', () => {
  const reserves = block('СобратьРезервы');
  assert.ok(reserves.indexOf('РегистрНайден = Ложь') < reserves.indexOf('Запрос.Выполнить()'));
  assert.ok(reserves.indexOf('РегистрНайден = Истина') > reserves.indexOf('КонецПопытки'));
  assert.match(reserves, /Исключение[^]*Возврат Соответствие;[^]*КонецПопытки/);
  assert.match(reserves, /Соответствие.Вставить\(ИдентификаторСсылки\(Выборка.Номенклатура\)/);
  assert.doesNotMatch(reserves, /Номенклатура.Код/);
});

test('invoice batches obey API limit and preserve original document type and date', () => {
  const invoices = block('ОтправитьНакладныеВыполнить', 'Процедура');
  assert.match(invoices, /РазмерПачки = 500/);
  assert.match(invoices, /Граница = Мин\(Номер \+ РазмерПачки, Записи.Количество\(\)\)/);
  assert.match(invoices, /Новый Структура\("records", Пачка\)/);
  assert.doesNotMatch(invoices, /Новый Структура\("records", Записи\)/);
  const collect = block('СобратьНакладныеДляОтправки');
  assert.match(collect, /"sourceDocumentType", "supplier_order"/);
  assert.match(collect, /"sourceDocumentDate", Формат\(Выборка.Дата/);
});

test('cell replacement snapshots keep each product together and withhold oversized groups', () => {
  const batches = block('СформироватьПакетыАдресов');
  assert.match(batches, /КлючТовара = Адрес.productExternalId/);
  assert.match(batches, /Если Группа.Количество\(\) > 500 Тогда[^]*Продолжить;/);
  assert.match(batches, /Если Пакет.Количество\(\) \+ Группа.Количество\(\) > 500 Тогда/);
  assert.match(block('ОтправитьОстаткиВыполнить', 'Процедура'), /Для Каждого ПачкаА Из ПакетыАдресов Цикл/);
});

test('stock preserves signed source numbers and distinguishes accepted negative values', () => {
  const collect = block('СобратьОстаткиДляОтправки');
  assert.match(collect, /Стр.Вставить\("qty", Выборка.Количество\)/);
  assert.doesNotMatch(collect, /ЧислоИлиПусто\(Выборка.Количество\)/);
  assert.match(source, /negative_accounting_stock/);
  assert.match(source, /skipped_unmapped_company/);
  assert.match(source, /X-Argus-Module-Version/);
  assert.match(source, /X-Argus-Run-Mode/);
});
