// Writes only to the explicitly isolated database below. Never loads .env.
// DATABASE_URL must be supplied by the test runner, using an RLS application role.
'use strict';

const assert = require('node:assert/strict');
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
const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
async function api(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
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
    const owner = ok(await api('POST', '/api/auth/owner/register', { body: {
      name: 'Reliability test owner', email: `reliability-${stamp}@test.local`,
      password: `isolated-${stamp}`, warehouseName: 'Reliability test warehouse',
    } }), 201);
    const warehouseId = owner.warehouse.id;
    const query = (sql, params = []) => withTenantContext({ warehouseId }, client => client.query(sql, params));
    const key = ok(await api('POST', '/api/sync/keys', { token: owner.token, body: { label: 'Reliability test' } }), 201);
    const sync = ok(await api('POST', '/api/sync/auth', { body: { keyCode: key.key_code } }));
    const push = async (stage, records, options = {}, headers = {}) => api('POST', `/api/sync/push/${stage}`, {
      token: sync.token, body: { records, ...options }, headers,
    });
    const companies = ok(await push('companies', [
      { externalId: 'company-a', name: 'Seller A' }, { externalId: 'company-b', name: 'Seller B' },
    ]));
    const companyA = companies.results[0].id;
    const companyB = companies.results[1].id;
    const legacy = ok(await api('POST', '/api/sellers/companies', { token: owner.token, body: { name: 'Legacy unassigned company' } }), 201);
    const product = (externalId, sku, companyExternalId) => ({ externalId, sku, companyExternalId, name: `Test ${sku}`, barcode: `000-${sku}` });
    ok(await push('products', [
      product('product-a', 'A', 'company-a'), product('product-b', 'B', 'company-b'),
      product('product-u1', 'U1'), product('product-u2', 'U2'), product('product-merge', 'MERGE'),
    ]));
    ok(await push('products', [product('product-legacy', 'LEGACY')], { defaultCompanyName: legacy.name }));
    const invoice = (externalId, number, items, companyExternalId = 'company-a') => ({ externalId, number, direction: 'in', companyExternalId, items });
    const line = (sku, productExternalId, declaredQty = 3) => ({ sku, productExternalId, name: `Test ${sku}`, declaredQty });
    const productRow = async externalId => (await query('SELECT * FROM products WHERE external_id=$1', [externalId])).rows[0];

    await check('negative 1C stock remains accounting data and does not invent physical stock', async () => {
      const pushed = ok(await push('stock', [{ productExternalId: 'product-a', sku: 'A', qty: -3 }]));
      assert.equal(pushed.results[0].status, 'updated');
      assert.equal(pushed.results[0].warning, 'negative_accounting_stock');
      assert.equal(Number((await productRow('product-a')).stock_qty_1c), -3);
      const sellerKey = ok(await api('POST', `/api/sellers/companies/${companyA}/keys`, { token: owner.token }), 201);
      const seller = ok(await api('POST', '/api/auth/seller/login', { body: { keyCode: sellerKey.key_code, name: 'Test seller' } }));
      const stock = ok(await api('GET', '/api/sellers/stock', { token: seller.token }));
      const a = stock.find(row => row.sku === 'A');
      assert.equal(a.qtyIn1c, -3);
      assert.equal(a.stockKnown, false);
      assert.equal(a.onHand, null);
      assert.equal(a.available, null);
    });

    await check('invalid quantities preserve previous 1C stock while good neighbors still update', async () => {
      const badValues = [null, '', ' ', false, [], {}, 'not-a-number'];
      const pushed = ok(await push('stock', [
        ...badValues.map(qty => ({ productExternalId: 'product-a', sku: 'A', qty })),
        { productExternalId: 'product-b', sku: 'B', qty: 9 },
      ]));
      assert.equal(pushed.results.filter(row => row.code === 'invalid_quantity').length, badValues.length);
      assert.equal(pushed.results.at(-1).status, 'updated');
      assert.equal(Number((await productRow('product-a')).stock_qty_1c), -3);
      assert.equal(Number((await productRow('product-b')).stock_qty_1c), 9);
    });

    await check('unmapped explicit counterparty cannot fall back to a legacy default', async () => {
      const pushed = ok(await push('invoices', [invoice('unmapped-doc', 'UNMAPPED', [line('A', 'product-a')], 'unknown-company')], { defaultCompanyName: 'Seller A' }));
      assert.equal(pushed.results[0].status, 'skipped_unmapped_company');
      assert.equal((await query('SELECT id FROM invoices WHERE external_id=$1', ['unmapped-doc'])).rowCount, 0);
    });

    await check('metadata survives re-push from an older module', async () => {
      const record = { ...invoice('metadata-doc', 'META', [line('A', 'product-a')]), sourceDocumentType: 'supplier_order', sourceDocumentDate: '2026-09-11T12:30:00' };
      assert.equal(ok(await push('invoices', [record])).results[0].status, 'created');
      assert.equal(ok(await push('invoices', [invoice('metadata-doc', 'META', [line('A', 'product-a', 4)])])).results[0].status, 'updated');
      const stored = (await query('SELECT source_document_type, source_document_date FROM invoices WHERE external_id=$1', ['metadata-doc'])).rows[0];
      assert.equal(stored.source_document_type, 'supplier_order');
      assert.equal(stored.source_document_date, '2026-09-11T12:30:00');
      const badDate = ok(await push('invoices', [{ ...record, sourceDocumentDate: '2026-02-30T12:30:00' }]));
      assert.equal(badDate.results[0].code, 'invalid_source_date');
      assert.equal((await query('SELECT source_document_date FROM invoices WHERE external_id=$1', ['metadata-doc'])).rows[0].source_document_date, stored.source_document_date);
    });

    await check('duplicate document number and malformed quantity do not roll back valid neighbors', async () => {
      const pushed = ok(await push('invoices', [
        invoice('neighbor-before', 'BEFORE', [line('A', 'product-a')]),
        invoice('duplicate-number', 'META', [line('A', 'product-a')]),
        invoice('malformed-quantity', 'BADQTY', [line('A', 'product-a', false)]),
        invoice('neighbor-after', 'AFTER', [line('A', 'product-a')]),
      ]));
      assert.deepEqual(pushed.results.map(row => row.status), ['created', 'error', 'error', 'created']);
      assert.equal((await query('SELECT id FROM invoices WHERE external_id=ANY($1::text[])', [['neighbor-before', 'neighbor-after']])).rowCount, 2);
      assert.equal((await query('SELECT id FROM invoices WHERE external_id=ANY($1::text[])', [['duplicate-number', 'malformed-quantity']])).rowCount, 0);
    });

    await check('malformed document text types are reported per document without aborting neighbors', async () => {
      const pushed = ok(await push('invoices', [
        invoice('typed-before', 'TYPE-BEFORE', [line('A', 'product-a')]),
        invoice(42, 'TYPE-BAD-ID', [line('A', 'product-a')]),
        invoice('typed-bad-name', 'TYPE-BAD-NAME', [{ ...line('A', 'product-a'), name: 42 }]),
        invoice('typed-after', 'TYPE-AFTER', [line('A', 'product-a')]),
      ]));
      assert.equal(pushed.results[0].status, 'created');
      assert.equal(pushed.results[1].status, 'error');
      assert.equal(pushed.results[2].status, 'error');
      assert.equal(pushed.results[3].status, 'created');
    });

    await check('conflicting new invoice rolls back earlier product claims and all inserted lines', async () => {
      const pushed = ok(await push('invoices', [invoice('conflict-new', 'CONFLICT-NEW', [line('U1', 'product-u1'), line('B', 'product-b')])]));
      assert.equal(pushed.results[0].status, 'ownership_conflict');
      assert.equal((await productRow('product-u1')).company_id, null);
      assert.equal((await productRow('product-b')).company_id, companyB);
      assert.equal((await query('SELECT id FROM invoices WHERE external_id=$1', ['conflict-new'])).rowCount, 0);
      assert.equal((await query('SELECT id FROM invoice_items WHERE sku=$1', ['U1'])).rowCount, 0);
    });

    await check('conflicting update keeps original invoice lines and unassigned product ownership', async () => {
      const before = (await query('SELECT i.id, i.declared_qty FROM invoice_items i JOIN invoices n ON n.id=i.invoice_id WHERE n.external_id=$1', ['metadata-doc'])).rows;
      const pushed = ok(await push('invoices', [invoice('metadata-doc', 'META', [line('U2', 'product-u2'), line('B', 'product-b')])]));
      assert.equal(pushed.results[0].status, 'ownership_conflict');
      const after = (await query('SELECT i.id, i.declared_qty FROM invoice_items i JOIN invoices n ON n.id=i.invoice_id WHERE n.external_id=$1', ['metadata-doc'])).rows;
      assert.deepEqual(after, before);
      assert.equal((await productRow('product-u2')).company_id, null);
    });

    await check('GUID and SKU disagreement cannot assign one product while recording another', async () => {
      const pushed = ok(await push('invoices', [invoice('identity-mismatch', 'MISMATCH', [line('WRONG-SKU', 'product-u2')])]));
      assert.ok(['ownership_conflict', 'error'].includes(pushed.results[0].status));
      assert.equal((await productRow('product-u2')).company_id, null);
      assert.equal((await query('SELECT id FROM invoices WHERE external_id=$1', ['identity-mismatch'])).rowCount, 0);
    });

    await check('unassigned 1C product merges into existing seller SKU without losing external stock', async () => {
      const manual = ok(await api('POST', '/api/products', { token: owner.token, body: { companyId: companyA, sku: 'MERGE', name: 'Seller catalog product' } }), 201);
      ok(await push('stock', [{ productExternalId: 'product-merge', sku: 'MERGE', qty: 17 }]));
      const pushed = ok(await push('invoices', [invoice('merge-doc', 'MERGE', [line('MERGE', 'product-merge')])]));
      assert.equal(pushed.results[0].status, 'created');
      const merged = await productRow('product-merge');
      assert.equal(merged.id, manual.id);
      assert.equal(merged.company_id, companyA);
      assert.equal(Number(merged.stock_qty_1c), 17);
      assert.equal((await query('SELECT id FROM products WHERE sku=$1', ['MERGE'])).rowCount, 1);
    });

    await check('old default company cannot hijack mapped products or documents', async () => {
      const catalog = ok(await push('products', [product('product-a', 'A')], { defaultCompanyName: legacy.name }));
      assert.equal(catalog.results[0].status, 'ownership_conflict');
      const docs = ok(await push('invoices', [{ ...invoice('metadata-doc', 'META', [line('A', 'product-a')]), companyExternalId: undefined }], { defaultCompanyName: legacy.name }));
      assert.equal(docs.results[0].status, 'ownership_conflict');
      assert.equal((await productRow('product-a')).company_id, companyA);
      assert.equal((await query('SELECT company_id FROM invoices WHERE external_id=$1', ['metadata-doc'])).rows[0].company_id, companyA);
    });

    await check('physical receiving history blocks legacy product transfer even on an open invoice', async () => {
      const legacyDoc = ok(await push('invoices', [{ ...invoice('legacy-work', 'LEGACY-WORK', [line('LEGACY', 'product-legacy')]), companyExternalId: undefined }], { defaultCompanyName: legacy.name })).results[0];
      const legacyItem = (await query('SELECT id FROM invoice_items WHERE invoice_id=$1', [legacyDoc.id])).rows[0];
      await query('INSERT INTO receiving_records(invoice_item_id, warehouse_id, company_id, accepted_qty) VALUES($1,$2,$3,1)', [legacyItem.id, warehouseId, legacy.id]);
      const transfer = ok(await push('invoices', [invoice('legacy-transfer', 'LEGACY-TRANSFER', [line('LEGACY', 'product-legacy')])]));
      assert.equal(transfer.results[0].status, 'ownership_conflict');
      assert.equal((await productRow('product-legacy')).company_id, legacy.id);
      const overwrite = ok(await push('invoices', [invoice('legacy-work', 'LEGACY-WORK', [line('LEGACY', 'product-legacy', 99)])]));
      assert.equal(overwrite.results[0].status, 'skipped_in_progress');
      assert.equal((await query('SELECT id FROM receiving_records WHERE invoice_item_id=$1', [legacyItem.id])).rowCount, 1);
      assert.equal(Number((await query('SELECT declared_qty FROM invoice_items WHERE id=$1', [legacyItem.id])).rows[0].declared_qty), 3);
    });

    await check('1C document counter excludes marketplace external identifiers', async () => {
      const prior = ok(await api('GET', '/api/sync/status', { token: owner.token }));
      const marketplace = ok(await api('POST', '/api/invoices', { token: owner.token, body: {
        companyId: companyA, number: 'MARKETPLACE-COUNT', direction: 'out',
        items: [{ sku: 'A', name: 'Marketplace order', declaredQty: 1 }],
      } }), 201);
      await query("UPDATE invoices SET source='wb', external_id='marketplace-external-id' WHERE id=$1", [marketplace.id]);
      const after = ok(await api('GET', '/api/sync/status', { token: owner.token }));
      assert.equal(after.synced_invoices, prior.synced_invoices);
    });

    await check('sync health stores stage/version/mode and counts warnings without raw payload', async () => {
      ok(await push('stock', [{ productExternalId: 'product-a', sku: 'A', qty: -2 }], {}, {
        'X-Argus-Module-Version': '2026-09-11 #12', 'X-Argus-Run-Mode': 'automatic',
      }));
      let health = ok(await api('GET', '/api/sync/status', { token: owner.token }));
      let stage = health.pushStages.find(row => row.stage === 'stock');
      assert.equal(stage.module_version, '2026-09-11 #12');
      assert.equal(stage.run_mode, 'automatic');
      assert.equal(stage.record_count, 1);
      assert.equal(stage.summary.updated, 1);
      assert.equal(stage.summary.warnings, 1);
      assert.ok(!JSON.stringify(stage).includes('product-a'));
      ok(await push('stock', [{ productExternalId: 'product-a', sku: 'A', qty: 0 }], {}, {
        'X-Argus-Module-Version': 'invalid-version-payload', 'X-Argus-Run-Mode': 'invalid-mode',
      }));
      health = ok(await api('GET', '/api/sync/status', { token: owner.token }));
      stage = health.pushStages.find(row => row.stage === 'stock');
      assert.equal(stage.module_version, null);
      assert.equal(stage.run_mode, null);
      assert.equal(Number((await productRow('product-a')).stock_qty_1c), 0);
    });

    await check('another warehouse cannot read sync telemetry or update this warehouse product by GUID', async () => {
      const other = ok(await api('POST', '/api/auth/owner/register', { body: {
        name: 'Other reliability owner', email: `other-reliability-${stamp}@test.local`,
        password: `isolated-${stamp}`, warehouseName: 'Other reliability warehouse',
      } }), 201);
      const health = ok(await api('GET', '/api/sync/status', { token: other.token }));
      assert.deepEqual(health.pushStages, []);
      const direct = await withTenantContext({ warehouseId: other.warehouse.id }, client => client.query('SELECT * FROM integration_sync_state'));
      assert.equal(direct.rowCount, 0);
      const otherKey = ok(await api('POST', '/api/sync/keys', { token: other.token, body: {} }), 201);
      const otherSync = ok(await api('POST', '/api/sync/auth', { body: { keyCode: otherKey.key_code } }));
      const pushed = ok(await api('POST', '/api/sync/push/stock', { token: otherSync.token, body: { records: [{ productExternalId: 'product-a', sku: 'A', qty: 999 }] } }));
      assert.equal(pushed.results[0].code, 'product_not_found');
      assert.equal(Number((await productRow('product-a')).stock_qty_1c), 0);
    });
  } catch (error) {
    failures.push('setup');
    console.error(`FAIL setup: ${error.message}`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
