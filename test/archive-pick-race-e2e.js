// Уход продавца в архив и одновременный отбор не сталкиваются (владелец
// 26.09.2026: «это невозможно»). Пока отбор держит строку продавца, архив
// ждёт; когда отбор записан — архив видит снятый товар и отказывает.
// Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Archive race E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');
const { setTimeout: sleep } = require('node:timers/promises');

(async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let passed = 0;
  const check = (label, fn) => { fn(); passed += 1; console.log(`PASS ${label}`); };
  async function api(method, path, token, body) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const must = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body; };
  try {
    const stamp = `${Date.now()}-${process.pid}`;
    const owner = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Race test', email: `race-${stamp}@test.local`, password: 'test-password-only', warehouseName: 'Race', city: 'Test',
    }), 201).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Гонка' }), 201).id;
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 2, tierCount: 1 }] }), 201);
    const cell = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks)[0].id;
    const order = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'РЛ-1', direction: 'out',
      items: [{ sku: 'R-1', name: 'Товар', declaredQty: 1 }] }), 201);

    // Отбор «в процессе»: держит строку продавца так же, как настоящий отбор.
    let archive; let settledEarly = false; let waitedForPick = false;
    await withTenantContext({ warehouseId }, async (c) => {
      await c.query('SELECT 1 FROM companies WHERE id = $1 FOR SHARE', [company]);
      archive = api('PATCH', `/api/sellers/companies/${company}/archive`, owner, { archived: true });
      archive.then(() => { settledEarly = true; });
      await sleep(700);
      waitedForPick = !settledEarly;
      await c.query(`INSERT INTO shipping_records (invoice_item_id, warehouse_id, company_id, picked_qty, cell_block_id, is_final, finished_at)
        VALUES ($1, $2, $3, 1, $4, true, now())`, [order.items[0].id, warehouseId, company, cell]);
    });
    const result = await archive;
    check('архив ждёт, пока идёт отбор', () => assert.equal(waitedForPick, true));
    check('после отбора архив отказывает: товар снят с полки', () => {
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.match(result.body.error, /РЛ-1/);
    });
    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error('FAIL', e);
    process.exitCode = 1;
  } finally {
    server.close();
    await require('../src/db/pool').pool.end();
  }
})();
