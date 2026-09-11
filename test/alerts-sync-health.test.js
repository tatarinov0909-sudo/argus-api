const test = require('node:test');
const assert = require('node:assert/strict');
const { RULES, THRESHOLDS } = require('../src/alerts/rules');
const syncBatches = RULES.find((rule) => rule.name === 'syncBatches');
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const row = (stage, options = {}) => ({
  stage, received_at: ago(5), run_mode: 'automatic', summary: { updated: 10 },
  last_seen_at: ago(1), ...options,
});
const run = (rows) => syncBatches({ query: async (sql, params) => {
  assert.deepEqual(params, ['warehouse-under-test']);
  assert.match(sql, /k\.warehouse_id = s\.warehouse_id AND k\.active/);
  return { rows };
} }, 'warehouse-under-test');

test('sync monitoring: healthy and not yet configured exchanges stay quiet', async () => {
  assert.deepEqual(await run([]), []);
  assert.deepEqual(await run([row('stock'), row('products')]), []);
});

test('sync monitoring: a fresh connection does not hide a stalled automatic stage', async () => {
  const alerts = await run([row('stock', { received_at: ago(THRESHOLDS.syncSilentMinutes + 1) }), row('products')]);
  assert.deepEqual(alerts.map((a) => a.key), ['sync_batches_stale']);
  assert.match(alerts[0].text, /учётные остатки/);
  assert.doesNotMatch(alerts[0].text, /товары/);
});

test('sync monitoring: full silence uses existing alert, manual stages do not require a schedule', async () => {
  assert.deepEqual(await run([row('stock', { received_at: ago(120), last_seen_at: ago(120) })]), []);
  assert.deepEqual(await run([row('stock', { received_at: ago(120), run_mode: 'manual' })]), []);
});

test('sync monitoring: row failures have a stable key and disappear after recovery', async () => {
  const alerts = await run([row('stock', { summary: { updated: 8, error: 2 } }), row('counterparties', { summary: { error: 1 } })]);
  assert.deepEqual(alerts.map((a) => a.key), ['sync_batch_errors']);
  assert.match(alerts[0].text, /3 ошибки/);
  assert.match(alerts[0].text, /порциях/);
  assert.deepEqual(await run([row('stock'), row('counterparties')]), []);
});

test('sync monitoring: pending seller mapping and warnings are not exchange failures', async () => {
  assert.deepEqual(await run([row('invoices', { summary: { updated: 26, pending_company: 113, warnings: 2 } })]), []);
});
