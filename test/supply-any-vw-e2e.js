// Поставка «из всего товара продавца» (владелец 06.10.2026): у продавца есть
// виртуальные склады, а собрать можно с любого — товар лежит на складе
// «Озон», поставка WB «из всего товара» его видит и собирает; продавцу о том,
// с какого склада собирают, не пишем. Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Supply any-VW E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');

let passed = 0;
let failed = 0;
const check = (label, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${label}`); } catch (e) { failed += 1; console.log(`FAIL ${label}\n  ${e.message}`); }
};
(async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, path, token, body) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  try {
    const stamp = `${Date.now()}-${process.pid}`;
    const owner = must(await api('POST', '/api/auth/owner/register', null, { name: 'Весь товар', email: `anyvw-${stamp}@test.local`,
      password: 'test-password-only', warehouseName: 'Весь товар', city: 'Test' }), 201).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Продавец' }), 201).id;
    must(await api('POST', '/api/products', owner, { sku: 'AV-1', name: 'Коврик', companyId: company }), 201);
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 2, tierCount: 1 }] }), 201);
    const cell = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks)[0].id;
    const ozon = must(await api('POST', '/api/vwarehouses', owner, { companyId: company, name: 'Озон', marketplace: 'ozon' }), 201);
    must(await api('POST', '/api/vwarehouses', owner, { companyId: company, name: 'WB продавца', marketplace: 'wb' }), 201);
    // Товар — только на складе «Озон».
    await run((c) => c.query(`INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, virtual_warehouse_id)
      VALUES ($1,$2,$3,'AV-1',4,$4)`, [cell, warehouseId, company, ozon.id]));
    const key = must(await api('POST', '/api/staff', owner, { name: 'Грузчик' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
    const order = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'WB-AV-1', direction: 'out',
      items: [{ sku: 'AV-1', name: 'Коврик', declaredQty: 2 }] }), 201);
    await run((c) => c.query(`UPDATE invoices SET source = 'wb', external_id = 'av-1' WHERE id = $1`, [order.id]));
    await run((c) => c.query(`UPDATE invoice_items SET mp_rid = 'rid-av-1' WHERE invoice_id = $1`, [order.id]));

    const noChoice = await api('POST', '/api/supplies', owner, { invoiceIds: [order.id], marketplace: 'wb' });
    const supply = must(await api('POST', '/api/supplies', owner, { invoiceIds: [order.id], marketplace: 'wb', virtualWarehouseId: 'all' }), 201);
    const listed = must(await api('GET', '/api/supplies', owner)).find((s) => s.id === supply.id);
    check('поставку можно составить «из всего товара продавца»', () => {
      assert.equal(noChoice.status, 400);
      assert.equal(supply.vwAny, true);
      assert.equal(listed.vw_any, true);
      assert.equal(listed.vw_name, 'Весь товар продавца');
    });

    must(await api('POST', `/api/shipping/assembly/${supply.id}/start`, worker, {}), 201);
    const hint = must(await api('GET', `/api/shipping/suggest/${order.items[0].id}`, worker));
    const sheet = must(await api('GET', `/api/shipping/pick-list?supplyId=${supply.id}`, worker));
    const picked = await api('POST', '/api/shipping', worker, { invoiceItemId: order.items[0].id, pickedQty: 2, cellBlockId: cell });
    const left = Number((await run((c) => c.query(`SELECT COALESCE(SUM(qty),0) AS n FROM cell_stock WHERE company_id = $1 AND sku = 'AV-1'`,
      [company]))).rows[0].n);
    check('грузчик видит товар склада «Озон» и собирает его', () => {
      assert.deepEqual(hint.cells.map((x) => x.available), [4]);
      assert.equal(sheet.lines[0].shortfall, 0);
      assert.equal(sheet.lines[0].vwName, 'Весь товар продавца');
      assert.equal(picked.status, 201, JSON.stringify(picked.body));
      assert.equal(left, 2);
    });

    const notes = (await run((c) => c.query(`SELECT count(*)::int AS n FROM seller_notifications WHERE company_id = $1`,
      [company]))).rows[0].n;
    check('продавцу о складе сборки не пишем', () => assert.equal(notes, 0));
  } catch (e) {
    failed += 1; console.log('FAIL тест упал: ' + e.stack);
  } finally {
    server.close(); await pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})();
