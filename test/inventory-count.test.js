const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateCountLines } = require('../src/inventory/count');
const companyId = '11111111-1111-1111-1111-111111111111';
const line = { sku: 'test', companyId, quality: 'good', qty: 7 };

test('count requires explicit numbers, seller and quality, without duplicate or omitted rows', () => {
  for (const qty of [undefined, null, '', '7', NaN, Infinity, -1, 1.5, true]) {
    assert.throws(() => validateCountLines([{ ...line, qty }], []));
  }
  for (const patch of [{ sku: '' }, { companyId: null }, { companyId: 'wrong' }, { quality: null }, { quality: 'wrong' }]) {
    assert.throws(() => validateCountLines([{ ...line, ...patch }], []));
  }
  assert.throws(() => validateCountLines([line, line], []));
  assert.throws(() => validateCountLines([], [line]));
  assert.deepEqual(validateCountLines([{ ...line, qty: 0 }], [line]), [{ ...line, qty: 0 }]);
  assert.deepEqual(validateCountLines([], []), []);
});

test('same SKU is distinct for two sellers or two quality states', () => {
  const otherSeller = { ...line, companyId: '22222222-2222-2222-2222-222222222222' };
  const defective = { ...line, quality: 'defective' };
  assert.equal(validateCountLines([line, otherSeller, defective], []).length, 3);
});
