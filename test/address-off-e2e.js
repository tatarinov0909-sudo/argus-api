// Адресное хранение выключено (владелец 06.10.2026): весь товар в общем месте
// «Склад», ячейки не выбирают; сборка сверх учёта — минус в «Складе»; схему
// можно перестроить, товар в «Складе» остаётся. Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Address-off E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
    const owner = must(await api('POST', '/api/auth/owner/register', null, { name: 'Без ячеек', email: `addr-${stamp}@test.local`,
      password: 'test-password-only', warehouseName: 'Без ячеек', city: 'Test' }), 201).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Продавец' }), 201).id;
    must(await api('POST', '/api/products', owner, { sku: 'AO-1', name: 'Гантели', companyId: company }), 201);
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 4, tierCount: 1 }] }), 201);
    const cells = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const [c1, c2, c3] = [1, 2, 3].map((rack) => cells.find((b) => b.rack_start === rack).id);
    await run((c) => c.query(`INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1,$2,$3,'AO-1',5)`,
      [c1, warehouseId, company]));
    const key = must(await api('POST', '/api/staff', owner, { name: 'Грузчик' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
    const stock = async () => (await run((c) => c.query(
      `SELECT cb.general, COALESCE(SUM(cs.qty), 0)::int AS qty FROM cell_stock cs JOIN cell_blocks cb ON cb.id = cs.cell_block_id
        WHERE cs.company_id = $1 AND cs.sku = 'AO-1' GROUP BY cb.general`, [company]))).rows;

    // ---------- выключить ----------
    const off = must(await api('PATCH', '/api/warehouses/me', owner, { addressStorage: false }));
    const rows = must(await api('GET', '/api/cells/rows', owner));
    const general = rows.find((r) => r.general);
    const afterOff = await stock();
    check('выключено: настройка, общее место и перенос товара', () => {
      assert.equal(off.address_storage, false);
      assert.ok(general, 'нет общего места');
      assert.equal(general.row_num, 0);
      assert.deepEqual(afterOff, [{ general: true, qty: 5 }]);
    });
    const generalId = general.blocks[0].id;

    // ---------- приёмка ----------
    const hint = must(await api('GET', '/api/agents/kladovshchik/suggest-cell?sku=AO-1&companyId=' + company, worker));
    const inv = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'ПР-АО-1',
      items: [{ sku: 'AO-1', name: 'Гантели', declaredQty: 10 }] }), 201);
    must(await api('POST', `/api/receiving/session/${inv.id}/start`, worker, {}), 201);
    const got = must(await api('POST', '/api/receiving', worker, { invoiceItemId: inv.items[0].id, acceptedQty: 10,
      placements: [{ cellBlockId: c2, qty: 6 }, { cellBlockId: c3, qty: 4 }] }), 201);
    const afterRecv = await stock();
    check('приёмка: подсказка — только «Склад», принятое ложится в «Склад», а не в выбранные ячейки', () => {
      assert.deepEqual(hint.options.map((o) => [o.label, o.reason]), [['Склад', 'general']]);
      assert.equal(got.unplaced, 0);
      assert.deepEqual(got.placements.map((p) => [p.label, p.qty]), [['Склад', 10]]);
      assert.deepEqual(afterRecv, [{ general: true, qty: 15 }]);
    });

    // ---------- сборка сверх учёта ----------
    const out = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'ОТГ-АО-1', direction: 'out',
      items: [{ sku: 'AO-1', name: 'Гантели', declaredQty: 20 }] }), 201);
    const pickHint = must(await api('GET', `/api/shipping/suggest/${out.items[0].id}`, worker));
    const list = must(await api('GET', `/api/shipping/pick-list?invoiceIds=${out.id}`, worker));
    const picked = must(await api('POST', '/api/shipping', worker, { invoiceItemId: out.items[0].id, pickedQty: 20, cellBlockId: c3 }), 201);
    const afterPick = await stock();
    const note = (await run((c) => c.query(
      `SELECT action_text FROM journal_entries WHERE warehouse_id = $1 AND entity_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [warehouseId, out.items[0].id]))).rows[0].action_text;
    check('сборка: «Склад» на 20 при учёте 15; лист без нехватки; взяли 20 — в «Складе» минус 5', () => {
      assert.equal(pickHint.addressOff, true);
      assert.deepEqual(pickHint.cells.map((x) => [x.label, x.available]), [['Склад', 20]]);
      assert.equal(pickHint.totalAvailable, 15);
      assert.deepEqual(list.lines[0].cells.map((x) => [x.label, x.take]), [['Склад', 20]]);
      assert.equal(list.lines[0].shortfall, 0);
      assert.equal(picked.overPicked, 5);
      assert.equal(picked.cell_block_id, generalId);
      assert.deepEqual(afterPick, [{ general: true, qty: -5 }]);
      assert.match(note, /сверх учёта: 5 шт\./);
    });

    // ---------- схема ----------
    const rebuilt = await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 2, tierCount: 1 }] });
    const rowsAfter = must(await api('GET', '/api/cells/rows', owner));
    check('перестройка схемы при товаре в «Складе»', () => {
      assert.equal(rebuilt.status, 201, JSON.stringify(rebuilt.body));
      assert.ok(rowsAfter.some((r) => r.general && r.row_num === 0));
      assert.equal(rowsAfter.filter((r) => !r.general).length, 1);
    });
    const kept = await stock();

    // ---------- включить ----------
    const on = must(await api('PATCH', '/api/warehouses/me', owner, { addressStorage: true }));
    const normal = must(await api('GET', '/api/cells/rows', owner)).find((r) => !r.general).blocks[0].id;
    let negative = null;
    try {
      await run((c) => c.query(`INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1,$2,$3,'AO-1',-1)`,
        [normal, warehouseId, company]));
    } catch (e) { negative = e.message; }
    check('включено снова: товар остаётся в «Складе»; минус в обычной ячейке запрещён', () => {
      assert.deepEqual(kept, [{ general: true, qty: -5 }]);
      assert.equal(on.address_storage, true);
      assert.match(negative || '', /меньше нуля/);
    });
  } catch (e) {
    failed += 1; console.log('FAIL тест упал: ' + e.stack);
  } finally {
    server.close(); await pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})();
