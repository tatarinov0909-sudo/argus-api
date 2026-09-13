const test = require('node:test');
const assert = require('node:assert/strict');
const { readStockCalculation } = require('../src/sync/stockCalculation');
const { recordBatch } = require('../src/sync/health');

function context(overrides = {}) {
  return {
    schemaVersion: 1, snapshotId: '254c10eb-98cb-46c4-8ae8-0d204a5b6c18',
    calculatedStartedAt: '2026-09-13T17:50:00', calculatedFinishedAt: '2026-09-13T17:50:02',
    timeBasis: '1c_local', registerName: 'ТоварыНаСкладах', balanceMode: 'current_totals',
    warehouseScope: 'all_in_register', productCodePrefix: 'PB', excludeDeleted: true,
    excludeGroups: true, quantityField: 'КоличествоОстаток', quantityUnit: 'register_unit',
    quantityConversion: 'none', totalRecords: 501, batchIndex: 2, batchCount: 2,
    ...overrides,
  };
}

test('calculation context retains source local clock and drops unrelated fields', () => {
  const value = context({ connectionDetails: 'must-not-be-retained', warehouseId: 'untrusted-scope' });
  const result = readStockCalculation(value, 1);
  assert.equal(result.status, 'accepted');
  assert.equal(result.calculation.calculatedFinishedAt, value.calculatedFinishedAt);
  assert.equal(result.calculation.timeBasis, '1c_local');
  assert.equal(result.calculation.connectionDetails, undefined);
  assert.equal(result.calculation.warehouseId, undefined);
  assert.ok('connectionDetails' in value, 'input is not mutated');
});

test('source clock rejects impossible, reversed and timezone-inventing timestamps', () => {
  for (const overrides of [
    { calculatedFinishedAt: '2026-02-30T17:50:02' },
    { calculatedFinishedAt: '2026-09-13T17:49:59' },
    { calculatedStartedAt: '2026-09-13T17:50:00Z' },
    { calculatedStartedAt: '2026-09-13T17:50:00+03:00' },
    { calculatedFinishedAt: '2026-09-13T25:50:02' },
  ]) assert.equal(readStockCalculation(context(overrides), 1).status, 'invalid');
});

test('invalid metadata is rejected without throwing or retaining raw input', () => {
  for (const value of [false, 42, 'text', [], {}, context({ registerName: '<script>' }),
    context({ schemaVersion: 2 }), context({ excludeGroups: false }),
    context({ totalRecords: '501' }), context({ batchCount: 1 }),
    context({ batchIndex: 3 }), context({ batchIndex: 0 }),
    context({ snapshotId: 'not-an-id' }), context({ quantityConversion: 'multiply' }),
  ]) assert.deepEqual(readStockCalculation(value, 1), { status: 'invalid', calculation: null });
  assert.equal(readStockCalculation(context(), 500).status, 'invalid', 'last batch count must agree');
  assert.equal(readStockCalculation(context({ batchIndex: 1 }), 500).status, 'accepted');
});

test('a legacy or invalid batch clears the previously declared calculation context', async () => {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); } };
  const req = { auth: { warehouseId: 'authenticated-warehouse', integrationKeyId: 'authenticated-key' },
    path: '/push/stock', get: () => undefined, body: { stockCalculation: context() } };
  const records = [{ qty: -2.5 }];
  const results = [{ status: 'updated', warning: 'negative_accounting_stock' }];
  assert.deepEqual(await recordBatch(client, req, records, results), { updated: 1, warnings: 1 });
  delete req.body.stockCalculation;
  await recordBatch(client, req, records, results);
  req.body.stockCalculation = { unexpected: 'input' };
  await recordBatch(client, req, records, results);
  assert.deepEqual(calls.map(x => x.values[8]), ['accepted', 'not_provided', 'invalid']);
  assert.equal(calls[1].values[7], null);
  assert.equal(calls[2].values[7], null);
  for (const call of calls) {
    assert.deepEqual(call.values.slice(0, 2), ['authenticated-warehouse', 'authenticated-key']);
    assert.match(call.sql, /stock_calculation = EXCLUDED.stock_calculation/);
  }
  assert.deepEqual(records, [{ qty: -2.5 }], 'metadata never transforms stock');
});

test('calculation fields on a non-stock stage are ignored', async () => {
  let values;
  await recordBatch({ query: async (_, params) => { values = params; } }, {
    auth: { warehouseId: 'warehouse', integrationKeyId: 'key' }, path: '/push/products',
    get: () => undefined, body: { stockCalculation: context() },
  }, [{}], [{ status: 'updated' }]);
  assert.equal(values[7], null);
  assert.equal(values[8], null);
});
