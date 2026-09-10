const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareInventoryExport } = require('../src/sellers/export');
const { validateSnapshot, planInventoryImport: plan } = require('../tools/inventory-import/plan');

const sellerId = '11111111-1111-4111-8111-111111111111';
const warehouseId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const now = '2026-09-11T10:10:00.000Z';
const generatedAt = '2026-09-11T10:05:00.000Z';
const target = { databaseId: 'test-base', organizationId: 'org-1', warehouseId: 'wh-1' };
const baseRow = { sku: 'A', name: 'Тестовый товар', barcode: '0000123456789', stockKnown: true, onHand: 100, ordered: 30, available: 70, countedAt: '2026-09-11T10:00:00.000Z' };
const snapshot = (rows = [baseRow], at = generatedAt) => prepareInventoryExport(rows, { seller: { id: sellerId, name: 'Тест' }, warehouse: { id: warehouseId } }, at).snapshot;
const context = () => ({
  binding: { sellerId, warehouseId, target: { ...target }, purpose: 'salesAvailability' },
  policy: { maxFileAgeMs: 3600000, maxStockAgeMs: 86400000, maxCatalogAgeMs: 600000 },
  catalog: { target: { ...target }, observedAt: '2026-09-11T10:09:00.000Z', items: [
    { barcode: baseRow.barcode, productId: 'local-A', characteristicId: null, unit: 'pcs', available: 50 },
    { barcode: '999', productId: 'untouched', characteristicId: null, unit: 'pcs', available: 500 },
  ] },
  journal: [],
});
const expectBlocked = (s, c, code) => {
  const result = plan(s, c, now);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.changes, []);
  assert.ok(result.issues.some(issue => issue.code === code), JSON.stringify(result.issues));
};

test('preview uses available only, preserves leading zeros, is absolute and leaves absent items alone', () => {
  const s = snapshot(); const c = context();
  const original = JSON.stringify({ s, c });
  const result = plan(s, c, now);
  assert.equal(result.status, 'ready_for_adapter');
  assert.equal(result.writesPerformed, false);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].barcode, '0000123456789');
  assert.equal(result.changes[0].before, 50);
  assert.equal(result.changes[0].after, 70);
  assert.equal(result.changes[0].operation, 'setSalesAvailability');
  assert.equal(result.changes[0].source.onHand, 100);
  assert.equal(JSON.stringify({ s, c }), original);
});

test('known zero replaces prior availability; negative availability is never invented for shortage', () => {
  for (const row of [{ ...baseRow, onHand: 0, ordered: 0, available: 0 }, { ...baseRow, onHand: 5, ordered: 10, available: 0 }]) {
    const result = plan(snapshot([row]), context(), now);
    assert.equal(result.status, 'ready_for_adapter');
    assert.equal(result.changes[0].after, 0);
  }
});

test('unchanged matched rows create no change and hashes ignore JSON property order', () => {
  const s = snapshot(); const c = context();
  c.catalog.items[0].available = 70;
  // Reorder root keys without filtering nested objects.
  const rootReordered = Object.fromEntries(Object.entries(s).reverse());
  const result = plan(rootReordered, c, now);
  assert.equal(result.status, 'ready_for_adapter');
  assert.equal(result.unchangedCount, 1);
  assert.deepEqual(result.changes, []);
});

test('repeat snapshot is a no-op even when re-downloaded later', () => {
  const c = context();
  c.journal.push({ sellerId, warehouseId, target, snapshotId: snapshot().snapshotId, generatedAt: '2026-09-11T10:04:00Z' });
  assert.equal(plan(snapshot(), c, now).status, 'already_applied');
  assert.deepEqual(plan(snapshot(), c, now).changes, []);
});

test('older and same-time different snapshots cannot overwrite a newer applied result', () => {
  for (const at of [generatedAt, '2026-09-11T10:06:00Z']) {
    const c = context();
    c.journal.push({ sellerId, warehouseId, target, snapshotId: 'a'.repeat(64), generatedAt: at });
    expectBlocked(snapshot(), c, 'stale_snapshot');
  }
});

test('journal and binding are scoped to both Argus source and local destination', () => {
  const c = context();
  c.journal.push({ sellerId: otherId, warehouseId, target, snapshotId: snapshot().snapshotId, generatedAt });
  c.journal.push({ sellerId, warehouseId, target: { ...target, warehouseId: 'other' }, snapshotId: snapshot().snapshotId, generatedAt });
  assert.equal(plan(snapshot(), c, now).status, 'ready_for_adapter');
  c.binding.warehouseId = otherId;
  expectBlocked(snapshot(), c, 'source_mismatch');
  c.binding = { ...c.binding, warehouseId, sellerId: otherId };
  expectBlocked(snapshot(), c, 'source_mismatch');
});

test('unknown format, semantics, fields, unsafe numbers and malformed dates are rejected', () => {
  for (const mutate of [
    s => s.schemaVersion = 2, s => s.quantityMode = 'delta', s => s.items[0].unit = 'pack',
    s => s.extra = true, s => s.items[0].extra = true, s => s.items[0].available = Number.MAX_SAFE_INTEGER + 1,
    s => s.items[0].barcode = 123, s => s.items[0].barcode = ' 123', s => s.items[0].barcode = '123\n',
    s => s.seller.id = { toString: 1 },
    s => s.generatedAt = '2026-02-30T10:05:00Z', s => s.generatedAt = '2026-09-11T10:05:00',
  ]) {
    const s = snapshot(); mutate(s);
    assert.equal(plan(s, context(), now).status, 'blocked');
  }
});

test('tampered quantities and invalid availability cannot pass checksum and semantic checks', () => {
  const s = snapshot(); s.items[0].onHand++; s.items[0].available++;
  expectBlocked(s, context(), 'content_mismatch');
  expectBlocked(snapshot([{ ...baseRow, available: 69 }]), context(), 'invalid_availability');
});

test('fresh download cannot conceal old, missing or future stock observation', () => {
  expectBlocked(snapshot([{ ...baseRow, countedAt: '2026-09-09T10:00:00Z' }]), context(), 'unconfirmed_freshness');
  expectBlocked(snapshot([{ ...baseRow, countedAt: null }]), context(), 'unconfirmed_freshness');
  expectBlocked(snapshot([{ ...baseRow, countedAt: '2026-09-11T10:06:00Z' }]), context(), 'invalid_stock_time');
  expectBlocked(snapshot([baseRow], '2026-09-11T10:11:00Z'), context(), 'expired_snapshot');
  expectBlocked(snapshot([{ ...baseRow, countedAt: '2026-09-11T08:00:00Z' }], '2026-09-11T08:05:00Z'), context(), 'expired_snapshot');
});

test('missing policy, wrong purpose and corrupt journal fail closed', () => {
  for (const mutate of [c => c.policy = {}, c => c.binding.purpose = 'physicalStock', c => c.journal = null, c => c.journal.push({})]) {
    const c = context(); mutate(c);
    assert.equal(plan(snapshot(), c, now).status, 'blocked');
  }
});

test('catalog must have fresh state and match database, organization and warehouse', () => {
  for (const field of ['databaseId', 'organizationId', 'warehouseId']) {
    const c = context(); c.catalog.target[field] = 'other';
    expectBlocked(snapshot(), c, 'catalog_scope_mismatch');
  }
  const c = context(); c.catalog.observedAt = '2026-09-11T09:00:00Z';
  expectBlocked(snapshot(), c, 'stale_catalog');
});

test('one unmatched or ambiguous barcode blocks whole snapshot without a partial plan', () => {
  const s = snapshot([baseRow, { ...baseRow, sku: 'B', barcode: '00002' }]);
  expectBlocked(s, context(), 'unmatched_barcode');
  const c = context(); c.catalog.items.push({ ...c.catalog.items[0], characteristicId: 'other' });
  expectBlocked(snapshot(), c, 'ambiguous_barcode');
});

test('duplicate source SKU/barcode and two barcodes targeting one destination block import', () => {
  const duplicateSku = snapshot([baseRow, { ...baseRow, barcode: '00002' }]);
  expectBlocked(duplicateSku, context(), 'duplicate_item');
  const s = snapshot([baseRow, { ...baseRow, sku: 'B', barcode: '00002' }]);
  const c = context(); c.catalog.items.push({ ...c.catalog.items[0], barcode: '00002' });
  expectBlocked(s, c, 'duplicate_target');
  s.items[1].barcode = s.items[0].barcode;
  expectBlocked(s, c, 'duplicate_item');
});

test('catalog packaging is not silently converted to pieces', () => {
  const c = context(); c.catalog.items[0].unit = 'pack';
  expectBlocked(snapshot(), c, 'unit_mismatch');
});

test('published v1 example conforms to the actual export checksum contract', () => {
  assert.deepEqual(validateSnapshot(require('../docs/argus-inventory-v1.example.json')), []);
});

test('CLI produces only a dry-run report and returns distinct codes for blocked data and bad input', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const cwd = path.join(__dirname, '..');
  const args = ['tools/inventory-import/cli.js', 'docs/argus-inventory-v1.example.json', 'tools/inventory-import/context.example.json'];
  const ready = spawnSync(process.execPath, [...args, '2026-09-10T10:10:00.000Z'], { cwd, encoding: 'utf8' });
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).status, 'ready_for_adapter');
  assert.equal(JSON.parse(ready.stdout).writesPerformed, false);
  const expired = spawnSync(process.execPath, [...args, '2026-09-12T10:10:00.000Z'], { cwd, encoding: 'utf8' });
  assert.equal(expired.status, 2, expired.stderr);
  assert.deepEqual(JSON.parse(expired.stdout).changes, []);
  const invalid = spawnSync(process.execPath, [args[0]], { cwd, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
});
