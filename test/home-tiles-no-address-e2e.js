// Владелец 10–11.10.2026: поставка и заказ физлицу — без адреса доставки;
// «Сводка склада» — новые заказы, сборка, дорога на WB, брак, проблемные
// товары (заказов больше остатка, набор не собрать) и клиенты.
// Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Home tiles E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
    const owner = must(await api('POST', '/api/auth/owner/register', null, { name: 'Сводка', email: `tiles-${stamp}@test.local`,
      password: 'test-password-only', warehouseName: 'Сводка', city: 'Test' }), 201).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    must(await api('PATCH', '/api/warehouses/me', owner, { stockSource: 'argus' }));
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Продавец' }), 201).id;
    for (const [sku, name] of [['T-1', 'Часть'], ['T-2', 'Пояс'], ['KIT-1', 'Набор: часть × 2']]) {
      must(await api('POST', '/api/products', owner, { sku, name, companyId: company }), 201);
    }
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 2, tierCount: 1 }] }), 201);
    const cell = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks)[0].id;
    await run((c) => c.query(`INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty)
      VALUES ($1,$2,$3,'T-1',3), ($1,$2,$3,'T-2',1), ($1,$2,$3,'KIT-1',0)`, [cell, warehouseId, company]));
    must(await api('PUT', `/api/kits/company/${company}/kit`, owner, { kitSku: 'KIT-1', components: [{ sku: 'T-1', qty: 2 }] }));

    // Заказ физлицу без адреса — создаётся; адреса нет, а не «null».
    const noAddress = must(await api('POST', '/api/direct-orders', owner, { companyId: company, recipient: 'Забирает сам',
      items: [{ sku: 'T-2', qty: 2 }] }), 201);
    const listed = must(await api('GET', '/api/direct-orders', owner)).rows.find((o) => o.id === noAddress.id);
    const entry = (await run((c) => c.query(`SELECT action_text FROM journal_entries WHERE invoice_id = $1 ORDER BY created_at LIMIT 1`,
      [noAddress.id]))).rows[0];
    check('заказ физлицу без адреса создаётся', () => { assert.equal(listed.address, null); assert.equal(listed.recipient, 'Забирает сам'); });
    check('в журнале нет «null» вместо адреса', () => assert.ok(entry && !/null/.test(entry.action_text), entry && entry.action_text));

    // «Сразу на сборку» без адреса — поставка «куда» = получатель.
    const toSupply = must(await api('POST', '/api/direct-orders', owner, { companyId: company, recipient: 'Петров',
      items: [{ sku: 'T-1', qty: 1 }], toSupply: true }), 201);
    const supply = must(await api('GET', `/api/supplies/${toSupply.supply.id}`, owner)).supply;
    check('поставка из заказа без адреса — «куда» это получатель', () => assert.equal(supply.destination, 'Петров'));

    // Поставка физлицу одним шагом — тоже без «куда / кому».
    const oneStep = await api('POST', '/api/supplies/direct', owner, { companyId: company, items: [{ sku: 'T-1', qty: 1 }] });
    check('поставка физлицу одним шагом без адреса — создаётся', () => assert.ok([200, 201].includes(oneStep.status), JSON.stringify(oneStep.body)));

    // Набор: 4 заказано, готовых 0, из частей собрать 0 (части заняты) — проблема.
    must(await api('POST', '/api/direct-orders', owner, { companyId: company, recipient: 'Набор', items: [{ sku: 'KIT-1', qty: 4 }] }), 201);
    const summary = must(await api('GET', '/api/sellers/stock-summary', owner)).sellers.find((s) => s.companyId === company);
    check('проблемные товары: пояса заказано больше, чем есть', () => assert.equal(summary.problemShortCount, 1, JSON.stringify(summary)));
    check('проблемные товары: набор не собрать из частей', () => assert.equal(summary.problemKitCount, 1, JSON.stringify(summary)));
    check('названия проблемных товаров — для подсказки', () => assert.ok(summary.problemNames.includes('Пояс') && summary.problemNames.includes('Набор: часть × 2'),
      JSON.stringify(summary.problemNames)));

    // Клиенты: один, кабинет выдан после ключа, WB не подключён.
    const before = must(await api('GET', '/api/alerts/today', owner)).clients;
    must(await api('POST', `/api/sellers/companies/${company}/keys`, owner, {}), 201);
    const today = must(await api('GET', '/api/alerts/today', owner));
    check('клиенты: всего и кабинет выдан', () => {
      assert.deepEqual(before, { total: 1, connected: 0, live: 0, cabinet: 0 });
      assert.deepEqual(today.clients, { total: 1, connected: 0, live: 0, cabinet: 1 });
    });
    check('несопоставленные артикулы считаются по товарам', () => assert.equal(today.exchange.wbUnmappedSkus, 0));
  } catch (e) {
    failed += 1; console.error('ОШИБКА ТЕСТА', e);
  } finally {
    server.close(); await pool.end();
    console.log(`\nСводка и поставки без адреса: ${passed} прошло, ${failed} упало`);
    process.exitCode = failed ? 1 : 0;
  }
})();
