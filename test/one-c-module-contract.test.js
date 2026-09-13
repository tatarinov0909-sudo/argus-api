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

test('calculation description preserves the existing stock query and one-read semantics', () => {
  const collect = block('СобратьОстаткиДляОтправки');
  assert.equal((collect.match(/Запрос\.Выполнить\(\)/g) || []).length, 1);
  assert.match(collect, /НайтиРегистрНакопленияПоСлову\("ТоварыНаСкладах"\)/);
  assert.match(collect, /НайтиРегистрНакопленияПоСлову\("ОстаткиТоваров"\)/);
  assert.match(collect, /ИмяРегистра \+ "\.Остатки КАК Остатки/);
  assert.doesNotMatch(collect, /\.Остатки\(|УстановитьПараметр|НачатьТранзакцию|Блокировк/);
  assert.match(collect, /НЕ Н\.ПометкаУдаления[^]*И НЕ Н\.ЭтоГруппа/);
  assert.match(collect, /ПустаяСтрока\(Код\) Или Не СтрНачинаетсяС\(ВРег\(Код\), "PB"\)/);
  assert.match(collect, /СГРУППИРОВАТЬ ПО[^]*Н\.Ссылка,[^]*Н\.Код/);
  assert.match(collect, /Стр\.Вставить\("qty", Выборка\.Количество\)/);
});

test('each successful stock read owns a fresh context and never reuses one after failure', () => {
  const collect = block('СобратьОстаткиДляОтправки');
  assert.match(collect, /^Функция СобратьОстаткиДляОтправки\(КонтекстРасчета = Неопределено\)/);
  assert.ok(collect.indexOf('КонтекстРасчета = Неопределено;') < collect.indexOf('ИмяРегистра ='));
  assert.ok(collect.indexOf('НачатьОписаниеРасчетаОстатков(ИмяРегистра)') < collect.indexOf('Запрос.Выполнить()'));
  assert.ok(collect.indexOf('"calculatedFinishedAt"') > collect.indexOf('Результат.Добавить(Стр)'));
  assert.ok(collect.indexOf('КонтекстРасчета = ОписаниеРасчета;') > collect.indexOf('"totalRecords", Результат.Количество()'));
  assert.match(collect, /Исключение\s+КонтекстРасчета = Неопределено;/);
  assert.doesNotMatch(source, /^Перем .*КонтекстРасчета/m);
});

test('stock context describes local time and actual calculation conditions without source secrets', () => {
  const describe = block('НачатьОписаниеРасчетаОстатков');
  const keys = [...describe.matchAll(/Описание\.Вставить\("([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(keys, [
    'schemaVersion', 'snapshotId', 'calculatedStartedAt', 'timeBasis', 'registerName',
    'balanceMode', 'warehouseScope', 'productCodePrefix', 'excludeDeleted', 'excludeGroups',
    'quantityField', 'quantityUnit', 'quantityConversion',
  ]);
  assert.match(describe, /"snapshotId", Строка\(Новый УникальныйИдентификатор\)/);
  assert.match(describe, /"calculatedStartedAt", Формат\(ТекущаяДата\(\), "ДФ=yyyy-MM-ddTHH:mm:ss"\)/);
  assert.match(describe, /"timeBasis", "1c_local"/);
  assert.match(describe, /"registerName", ИмяРегистра/);
  assert.match(describe, /"warehouseScope", "all_in_register"/);
  assert.match(describe, /"quantityField", "КоличествоОстаток"/);
  assert.match(describe, /"quantityUnit", "register_unit"/);
  assert.match(describe, /"quantityConversion", "none"/);
  assert.match(describe, /Исключение[^]*Возврат Неопределено;/);
  assert.doesNotMatch(describe, /ОписаниеОшибки|СтрокаСоединения|ИмяКомпьютера|ИмяПользователя|КлючИнтеграции|мТокен/);
});

test('HTTP stock batches share calculation context and file export uses the captured read', () => {
  const send = block('ОтправитьОстаткиВыполнить', 'Процедура');
  assert.equal((send.match(/СобратьОстаткиДляОтправки\(КонтекстРасчета\)/g) || []).length, 1);
  assert.ok(send.indexOf('СобратьОстаткиДляОтправки') < send.indexOf('Пока Номер <'));
  assert.match(send, /ДобавитьКонтекстРасчетаОстатков\(Тело, КонтекстРасчета,\s+Цел\(Номер \/ РазмерПачки\) \+ 1, Цел\(\(Записи\.Количество\(\) - 1\) \/ РазмерПачки\) \+ 1\);\s+Ответ = ВыполнитьЗапрос\("POST", "\/api\/sync\/push\/stock"/);
  const file = block('ВыгрузитьВФайлВыполнить', 'Процедура');
  assert.equal((file.match(/СобратьОстаткиДляОтправки\(КонтекстРасчета\)/g) || []).length, 1);
  assert.match(file, /ДобавитьКонтекстРасчетаОстатков\(Выгрузка, КонтекстРасчета\);/);
  assert.doesNotMatch(file, /НачатьОписаниеРасчетаОстатков|batchIndex|batchCount/);
});

test('optional stock context is cloned and cannot block legacy stock transfer', () => {
  const attach = block('ДобавитьКонтекстРасчетаОстатков', 'Процедура');
  assert.match(attach, /КонтекстРасчета = Неопределено Тогда Возврат;/);
  assert.match(attach, /Для Каждого Поле Из КонтекстРасчета Цикл\s+Описание\.Вставить\(Поле\.Ключ, Поле\.Значение\)/);
  assert.doesNotMatch(attach, /КонтекстРасчета\.Вставить/);
  assert.match(attach, /Если НомерПачки <> Неопределено И ВсегоПачек <> Неопределено Тогда[^]*"batchIndex", НомерПачки[^]*"batchCount", ВсегоПачек/);
  assert.match(attach, /Попытка[^]*Тело\.Вставить\("stockCalculation", Описание\);\s+Исключение[^]*КонецПопытки/);
  for (const name of ['НачатьОписаниеРасчетаОстатков', 'ДобавитьКонтекстРасчетаОстатков']) {
    const added = block(name, name.startsWith('Добавить') ? 'Процедура' : 'Функция');
    assert.doesNotMatch(added, /мОшибокОбмена|ВызватьИсключение|Запрос\.Выполнить|\.Записать\(/);
  }
  const firstFunction = source.indexOf('Функция ВерсияМодуля');
  assert.doesNotMatch(source.slice(firstFunction), /^Перем /m);
});
