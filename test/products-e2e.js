// End-to-end check of the products directory and the 1C external_id fields,
// against a real Postgres, connected as argus_app so RLS actually applies.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/products-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();

    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Prod Owner',
        email: `prod${stamp}@test.local`,
        password: 'secret123',
        warehouseName: 'Prod Warehouse',
      },
    });
    assert.equal(reg.status, 201, `register: ${JSON.stringify(reg.body)}`);
    const ownerToken = reg.body.token;

    const compA = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Alpha' },
    });
    const compAId = compA.body.id;
    const compB = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Beta' },
    });
    const compBId = compB.body.id;

    // ---------- Create ----------
    const created = await api('POST', '/api/products', {
      token: ownerToken,
      body: {
        companyId: compAId, sku: 'SKU-A1', name: 'Blue Widget', category: 'Widgets',
        lengthMm: 200, widthMm: 150, heightMm: 80, weightG: 450,
      },
    });
    check('product created with category and dimensions', () => {
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.category, 'Widgets');
      assert.equal(Number(created.body.length_mm), 200);
      assert.equal(Number(created.body.weight_g), 450);
      assert.equal(created.body.active, true);
    });

    const noDims = await api('POST', '/api/products', {
      token: ownerToken,
      body: { companyId: compAId, sku: 'SKU-A2', name: 'Plain Item' },
    });
    check('dimensions are optional', () => {
      assert.equal(noDims.status, 201, JSON.stringify(noDims.body));
      assert.equal(noDims.body.length_mm, null);
      assert.equal(noDims.body.category, null);
    });

    const dup = await api('POST', '/api/products', {
      token: ownerToken,
      body: { companyId: compAId, sku: 'SKU-A1', name: 'Duplicate' },
    });
    check('duplicate sku for same company rejected', () => {
      assert.equal(dup.status, 409, JSON.stringify(dup.body));
    });

    const sameSkuOtherCompany = await api('POST', '/api/products', {
      token: ownerToken,
      body: { companyId: compBId, sku: 'SKU-A1', name: 'Beta version' },
    });
    check('same sku allowed for a different company', () => {
      assert.equal(sameSkuOtherCompany.status, 201, JSON.stringify(sameSkuOtherCompany.body));
    });

    const badDim = await api('POST', '/api/products', {
      token: ownerToken,
      body: { companyId: compAId, sku: 'SKU-BAD', name: 'Bad', lengthMm: 'широкий' },
    });
    check('non-numeric dimension rejected instead of silently zeroed', () => {
      assert.equal(badDim.status, 400, JSON.stringify(badDim.body));
    });

    const negative = await api('POST', '/api/products', {
      token: ownerToken,
      body: { companyId: compAId, sku: 'SKU-NEG', name: 'Neg', weightG: -5 },
    });
    check('negative dimension rejected', () => {
      assert.equal(negative.status, 400, JSON.stringify(negative.body));
    });

    const missing = await api('POST', '/api/products', {
      token: ownerToken, body: { companyId: compAId, sku: '   ', name: 'Blank' },
    });
    check('blank sku rejected', () => {
      assert.equal(missing.status, 400, JSON.stringify(missing.body));
    });

    // ---------- List ----------
    const all = await api('GET', '/api/products', { token: ownerToken });
    check('owner lists the whole catalogue', () => {
      assert.equal(all.status, 200, JSON.stringify(all.body));
      assert.equal(all.body.length, 3, `got ${all.body.length}`);
      assert.ok(all.body[0].company_name, 'company name should be joined in');
    });

    const filtered = await api('GET', `/api/products?companyId=${compBId}`, { token: ownerToken });
    check('list filters by company', () => {
      assert.equal(filtered.body.length, 1, `got ${filtered.body.length}`);
      assert.equal(filtered.body[0].company_id, compBId);
    });

    // ---------- Update ----------
    const patched = await api('PATCH', `/api/products/${created.body.id}`, {
      token: ownerToken, body: { category: 'Premium Widgets', weightG: 500 },
    });
    check('partial update touches only given fields', () => {
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.equal(patched.body.category, 'Premium Widgets');
      assert.equal(Number(patched.body.weight_g), 500);
      assert.equal(Number(patched.body.length_mm), 200, 'length must be untouched');
      assert.equal(patched.body.name, 'Blue Widget', 'name must be untouched');
    });

    const emptyPatch = await api('PATCH', `/api/products/${created.body.id}`, {
      token: ownerToken, body: {},
    });
    check('empty update rejected', () => {
      assert.equal(emptyPatch.status, 400, JSON.stringify(emptyPatch.body));
    });

    const archived = await api('PATCH', `/api/products/${noDims.body.id}`, {
      token: ownerToken, body: { active: false },
    });
    check('product can be archived', () => {
      assert.equal(archived.body.active, false);
    });

    const activeOnly = await api('GET', '/api/products', { token: ownerToken });
    check('archived products hidden by default', () => {
      assert.equal(activeOnly.body.length, 2, `got ${activeOnly.body.length}`);
    });

    const withArchived = await api('GET', '/api/products?includeInactive=true', { token: ownerToken });
    check('archived products visible on request', () => {
      assert.equal(withArchived.body.length, 3, `got ${withArchived.body.length}`);
    });

    // ---------- external_id ----------
    const withExt = await api('PATCH', `/api/products/${created.body.id}`, {
      token: ownerToken, body: { externalId: '1c-guid-0001' },
    });
    check('external_id can be attached to an existing product', () => {
      assert.equal(withExt.body.external_id, '1c-guid-0001');
    });

    const dupExt = await api('POST', '/api/products', {
      token: ownerToken,
      body: {
        companyId: compBId, sku: 'SKU-OTHER', name: 'Other', externalId: '1c-guid-0001',
      },
    });
    check('duplicate 1C id within a warehouse is rejected by the DB', () => {
      assert.ok(dupExt.status >= 400, `expected an error, got ${dupExt.status}`);
    });

    // Two products with no 1C id yet must not collide — the partial unique
    // index has to ignore NULLs, which is the whole reason it is partial.
    const nullExt1 = await api('POST', '/api/products', {
      token: ownerToken, body: { companyId: compAId, sku: 'SKU-N1', name: 'No ext 1' },
    });
    const nullExt2 = await api('POST', '/api/products', {
      token: ownerToken, body: { companyId: compAId, sku: 'SKU-N2', name: 'No ext 2' },
    });
    check('several products without a 1C id coexist', () => {
      assert.equal(nullExt1.status, 201, JSON.stringify(nullExt1.body));
      assert.equal(nullExt2.status, 201, JSON.stringify(nullExt2.body));
    });

    const extCols = await pool.query(`
      SELECT table_name FROM information_schema.columns
      WHERE column_name = 'external_id'
        AND table_name IN ('products','companies','invoices','invoice_items')
      ORDER BY table_name
    `);
    check('external_id exists on all four synced tables', () => {
      const names = extCols.rows.map((r) => r.table_name);
      assert.deepEqual(names, ['companies', 'invoice_items', 'invoices', 'products'], names.join(','));
    });

    // ---------- Seller isolation ----------
    const keyA = await api('POST', `/api/sellers/companies/${compAId}/keys`, { token: ownerToken });
    const sellerA = await api('POST', '/api/auth/seller/login', {
      body: { keyCode: keyA.body.key_code, name: 'Seller A' },
    });
    const sellerToken = sellerA.body.token;

    const sellerList = await api('GET', '/api/products', { token: sellerToken });
    check('seller sees only their own catalogue', () => {
      assert.equal(sellerList.status, 200, JSON.stringify(sellerList.body));
      assert.ok(sellerList.body.length > 0, 'seller should see their own products');
      assert.ok(
        sellerList.body.every((p) => p.company_id === compAId),
        'seller can see another company\'s products',
      );
    });

    const sellerCreate = await api('POST', '/api/products', {
      token: sellerToken, body: { companyId: compAId, sku: 'SKU-HACK', name: 'Nope' },
    });
    check('seller cannot create products', () => {
      assert.equal(sellerCreate.status, 403, JSON.stringify(sellerCreate.body));
    });

    const sellerPatch = await api('PATCH', `/api/products/${created.body.id}`, {
      token: sellerToken, body: { name: 'Hacked' },
    });
    check('seller cannot edit products', () => {
      assert.equal(sellerPatch.status, 403, JSON.stringify(sellerPatch.body));
    });

    // ---------- Shipping suggest picks up the product card ----------
    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'W' } });
    const workerLogin = await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    });
    const workerToken = workerLogin.body.token;

    await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 2, tierCount: 1 }] },
    });
    const rows = await api('GET', '/api/cells/rows', { token: ownerToken });
    const cell = rows.body[0].blocks[0];

    const inbound = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: compAId, number: `IN-${stamp}`, direction: 'in',
        items: [{ name: 'Blue Widget', sku: 'SKU-A1', declaredQty: 20 }],
      },
    });
    await api('POST', '/api/receiving', {
      token: workerToken,
      body: { invoiceItemId: inbound.body.items[0].id, acceptedQty: 20, cellBlockId: cell.id },
    });

    const outbound = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: compAId, number: `OUT-${stamp}`, direction: 'out',
        items: [{ name: 'Blue Widget', sku: 'SKU-A1', declaredQty: 5 }],
      },
    });
    const suggest = await api('GET', `/api/shipping/suggest/${outbound.body.items[0].id}`, {
      token: workerToken,
    });
    check('suggest carries category and dimensions from the product card', () => {
      assert.equal(suggest.status, 200, JSON.stringify(suggest.body));
      assert.equal(suggest.body.item.category, 'Premium Widgets');
      assert.equal(suggest.body.item.dimensions.lengthMm, 200);
      assert.equal(suggest.body.item.dimensions.weightG, 500);
    });

    // A SKU with no directory card must report unknown, not fabricated zeroes.
    const orphanIn = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: compAId, number: `IN-ORPH-${stamp}`, direction: 'in',
        items: [{ name: 'Ghost', sku: 'SKU-NOCARD', declaredQty: 3 }],
      },
    });
    await api('POST', '/api/receiving', {
      token: workerToken,
      body: { invoiceItemId: orphanIn.body.items[0].id, acceptedQty: 3, cellBlockId: cell.id },
    });
    const orphanOut = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: compAId, number: `OUT-ORPH-${stamp}`, direction: 'out',
        items: [{ name: 'Ghost', sku: 'SKU-NOCARD', declaredQty: 1 }],
      },
    });
    const orphanSuggest = await api('GET', `/api/shipping/suggest/${orphanOut.body.items[0].id}`, {
      token: workerToken,
    });
    check('unknown SKU reports null dimensions, not zeroes', () => {
      assert.equal(orphanSuggest.status, 200, JSON.stringify(orphanSuggest.body));
      assert.equal(orphanSuggest.body.item.category, null);
      assert.equal(orphanSuggest.body.item.dimensions, null);
      assert.equal(orphanSuggest.body.cells.length, 1, 'stock lookup must still work');
    });
  } catch (err) {
    failures.push({ name: 'SETUP', message: err.message });
    console.log(`\n  SETUP ERROR: ${err.message}\n${err.stack}`);
  } finally {
    server.close();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  }
  process.exit(failures.length ? 1 : 0);
})();
