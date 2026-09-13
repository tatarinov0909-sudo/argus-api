// Writes only to the explicitly isolated database below. Never loads .env.
// DATABASE_URL must be supplied by a runner using a non-superuser RLS role.
'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const TEST_DB = 'argus_seller_test_20260910';
let configured;
try { configured = new URL(process.env.DATABASE_URL); } catch {}
if (!configured || decodeURIComponent(configured.pathname.slice(1)) !== TEST_DB) {
  console.error(`REFUSED: DATABASE_URL must explicitly target ${TEST_DB}`);
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('REFUSED: supply an isolated JWT_SECRET');
  process.exit(1);
}
process.env.LOG_LEVEL = 'silent';
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');

let base;
let passed = 0;
const failures = [];
const stamp = randomUUID();
async function api(method, path, { token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
function ok(response, status = 200) {
  assert.equal(response.status, status, `Unexpected HTTP ${response.status}; expected ${status}`);
  return response.body;
}
async function check(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error.message}`); }
}
function calculation(overrides = {}) {
  return {
    schemaVersion: 1,
    snapshotId: randomUUID(),
    calculatedStartedAt: '2026-09-13T18:00:00',
    calculatedFinishedAt: '2026-09-13T18:00:02',
    timeBasis: '1c_local',
    registerName: 'ТоварыНаСкладах',
    balanceMode: 'current_totals',
    warehouseScope: 'all_in_register',
    productCodePrefix: 'PB',
    excludeDeleted: true,
    excludeGroups: true,
    quantityField: 'КоличествоОстаток',
    quantityUnit: 'register_unit',
    quantityConversion: 'none',
    totalRecords: 3,
    batchIndex: 1,
    batchCount: 1,
    ...overrides,
  };
}

(async () => {
  let server;
  try {
    const guard = await withTenantContext({}, client => client.query(`SELECT current_database() AS db,
      rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    assert.equal(guard.rows[0].db, TEST_DB, 'Wrong test database');
    assert.equal(guard.rows[0].rolsuper, false, 'Tests require a non-superuser');
    assert.equal(guard.rows[0].rolbypassrls, false, 'Tests require RLS enforcement');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    async function ownerFor(label) {
      return ok(await api('POST', '/api/auth/owner/register', { body: {
        name: 'Stock calculation test owner',
        email: `stock-calculation-${label}-${stamp}@test.local`,
        password: `isolated-${stamp}`,
        warehouseName: `Stock calculation test ${label}`,
      } }), 201);
    }
    async function integrationFor(owner) {
      const key = ok(await api('POST', '/api/sync/keys', { token: owner.token, body: { label: 'Isolated test' } }), 201);
      return ok(await api('POST', '/api/sync/auth', { body: { keyCode: key.key_code } }));
    }
    const owner = await ownerFor('main');
    const warehouseId = owner.warehouse.id;
    const integration = await integrationFor(owner);
    const query = (sql, params = []) => withTenantContext({ warehouseId }, client => client.query(sql, params));
    const push = (stage, records, extra = {}, token = integration.token) => api('POST', `/api/sync/push/${stage}`, {
      token, body: { records, ...extra },
    });
    const companies = ok(await push('companies', [{ externalId: 'company-a', name: 'Isolated seller' }]));
    const companyId = companies.results[0].id;
    const skus = ['PB-STOCK-A', 'PB-STOCK-B', 'PB-STOCK-C'];
    ok(await push('products', skus.map((sku, index) => ({
      externalId: `product-${index}`, sku, companyExternalId: 'company-a', name: `Test ${sku}`,
    }))));
    const records = quantities => skus.map((sku, index) => ({
      productExternalId: `product-${index}`, sku, qty: quantities[index],
    }));
    async function assertQuantities(expected) {
      const stored = (await query('SELECT sku,stock_qty_1c FROM products WHERE company_id=$1 ORDER BY sku', [companyId])).rows;
      assert.deepEqual(stored.map(row => Number(row.stock_qty_1c)), expected);
    }
    async function health(token = owner.token) {
      return ok(await api('GET', '/api/sync/status', { token })).pushStages.find(row => row.stage === 'stock');
    }
    async function assertState(status, metadata) {
      const stage = await health();
      assert.equal(stage.stock_calculation_status, status);
      assert.deepEqual(stage.stock_calculation, metadata);
      const stored = (await query("SELECT stock_calculation_status,stock_calculation FROM integration_sync_state WHERE stage='stock'")).rows;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].stock_calculation_status, status);
      assert.deepEqual(stored[0].stock_calculation, metadata);
      return stage;
    }

    await check('legacy stock remains accepted without pretending calculation metadata exists', async () => {
      const result = ok(await push('stock', records([40, 0, -2])));
      assert.equal(result.summary.updated, 3);
      await assertQuantities([40, 0, -2]);
      await assertState('not_provided', null);
    });

    await check('new metadata preserves exact quantities and source-local calculation times', async () => {
      const metadata = calculation();
      const result = ok(await push('stock', records([0, 17.5, -3]), { stockCalculation: metadata }));
      assert.equal(result.summary.updated, 3);
      await assertQuantities([0, 17.5, -3]);
      const stage = await assertState('accepted', metadata);
      assert.equal(stage.record_count, 3);
      assert.equal(stage.summary.warnings, 1);
      assert.notEqual(stage.received_at, metadata.calculatedFinishedAt);
    });

    await check('invalid metadata is discarded while independently valid stock still updates', async () => {
      const invalid = [
        calculation({ schemaVersion: 999 }),
        calculation({ snapshotId: 'not-a-uuid' }),
        calculation({ calculatedFinishedAt: '2026-09-13T17:59:59' }),
        calculation({ totalRecords: 4 }),
        calculation({ batchIndex: 2 }),
      ];
      for (const [index, metadata] of invalid.entries()) {
        const expected = [index + 1, 0, -index - 1];
        assert.equal(ok(await push('stock', records(expected), { stockCalculation: metadata })).summary.updated, 3);
        await assertQuantities(expected);
        await assertState('invalid', null);
      }
    });

    await check('metadata cannot turn a malformed quantity into a stock overwrite', async () => {
      ok(await push('stock', records([15, 2, 3])));
      const metadata = calculation();
      const result = ok(await push('stock', records([false, 6.25, 0]), { stockCalculation: metadata }));
      assert.equal(result.results[0].code, 'invalid_quantity');
      assert.equal(result.summary.updated, 2);
      await assertQuantities([15, 6.25, 0]);
      await assertState('accepted', metadata);
    });

    await check('legacy push after a new module clears stale calculation metadata', async () => {
      const metadata = calculation();
      ok(await push('stock', records([10, 20, 30]), { stockCalculation: metadata }));
      await assertState('accepted', metadata);
      ok(await push('stock', records([9, 19, 29])));
      await assertQuantities([9, 19, 29]);
      await assertState('not_provided', null);
    });

    await check('another owner and integration stay isolated despite matching external IDs', async () => {
      const ownMetadata = calculation();
      ok(await push('stock', records([7, 8, 9]), { stockCalculation: ownMetadata }));
      const other = await ownerFor('other');
      const otherStatus = ok(await api('GET', '/api/sync/status', { token: other.token }));
      assert.deepEqual(otherStatus.pushStages, []);
      const visible = await withTenantContext({ warehouseId: other.warehouse.id }, client => client.query('SELECT * FROM integration_sync_state'));
      assert.equal(visible.rowCount, 0);
      const otherIntegration = await integrationFor(other);
      const otherMetadata = calculation();
      const result = ok(await push('stock', records([999, 999, 999]), { stockCalculation: otherMetadata }, otherIntegration.token));
      assert.ok(result.results.every(row => row.code === 'product_not_found'));
      assert.equal((await health(other.token)).stock_calculation.snapshotId, otherMetadata.snapshotId);
      await assertQuantities([7, 8, 9]);
      await assertState('accepted', ownMetadata);
    });

    await check('calculation details are owner-only and absent from the seller stock payload', async () => {
      const sellerKey = ok(await api('POST', `/api/sellers/companies/${companyId}/keys`, { token: owner.token }), 201);
      const seller = ok(await api('POST', '/api/auth/seller/login', { body: { keyCode: sellerKey.key_code, name: 'Test seller' } }));
      const staffKey = ok(await api('POST', '/api/staff', { token: owner.token, body: { name: 'Test staff' } }), 201);
      const staff = ok(await api('POST', '/api/auth/staff/login', { body: { keyCode: staffKey.key_code } }));
      ok(await api('GET', '/api/sync/status'), 401);
      for (const token of [seller.token, staff.token, integration.token]) {
        ok(await api('GET', '/api/sync/status', { token }), 403);
      }
      const stock = ok(await api('GET', '/api/sellers/stock', { token: seller.token }));
      assert.deepEqual(stock.map(row => row.qtyIn1c).sort((a, b) => a - b), [7, 8, 9]);
      for (const row of stock) {
        assert.ok(!Object.hasOwn(row, 'stockCalculation'));
        assert.ok(!Object.hasOwn(row, 'stock_calculation'));
        assert.equal(row.stockKnown, false);
      }
    });
  } catch (error) {
    failures.push('setup');
    console.error(`FAIL setup: ${error.message}`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
})();
