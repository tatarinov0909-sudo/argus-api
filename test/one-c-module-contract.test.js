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
