// Isolated test fixtures only: never runs against the production database.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Inventory safety E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');
const service = require('../src/inventory/service');

(async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let passed = 0;
  const check = (label, fn) => { fn(); passed++; console.log(`PASS ${label}`); };
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
    async function account(suffix) {
      return must(await api('POST', '/api/auth/owner/register', null, {
        name: 'Inventory test', email: `inventory-safe-${stamp}-${suffix}@test.local`,
        password: 'test-password-only', warehouseName: 'Test warehouse', city: 'Test city',
      }), 201);
    }
    const accountA = await account('a');
    const accountB = await account('b');
    const owner = accountA.token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64')).warehouseId;
    const ownerId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64')).ownerId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Test seller A' }), 201).id;
    const company2 = must(await api('POST', '/api/sellers/companies', owner, { name: 'Test seller B' }), 201).id;
    const foreign = must(await api('POST', '/api/sellers/companies', accountB.token, { name: 'Foreign test seller' }), 201).id;
    async function product(sku, companyId = company, token = owner) {
      must(await api('POST', '/api/products', token, { sku, name: `Test product ${sku}`, companyId }), 201);
    }
    await product('SAME'); await product('SAME', company2); await product('ZERO');
    await product('FOREIGN', foreign, accountB.token);
    const staff = must(await api('POST', '/api/staff', owner, { name: 'Test counter' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code })).token;
    const managerKey = must(await api('POST', '/api/staff', owner, { name: 'Test manager', kind: 'manager' }), 201);
    const manager = must(await api('POST', '/api/auth/staff/login', null, { keyCode: managerKey.key_code })).token;
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 8, tierCount: 2 }] }), 201);
    const cells = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks).map((b) => b.id);
    const line = (qty, overrides = {}) => ({ sku: 'SAME', companyId: company, quality: 'good', qty, ...overrides });
    async function task(cell) {
      const id = await run(async (c) => {
        const r = await c.query('INSERT INTO inventory_runs(warehouse_id) VALUES($1) RETURNING id', [warehouseId]);
        return (await c.query(`INSERT INTO inventory_tasks(run_id,warehouse_id,cell_block_id,reason)
          VALUES($1,$2,$3,'Isolated regression fixture') RETURNING id`, [r.rows[0].id, warehouseId, cell])).rows[0].id;
      });
      const opened = must(await api('POST', `/api/inventory/tasks/${id}/open`, worker));
      return { id, cell, opened };
    }
    async function insert(cell, qty, sku = 'SAME') {
      await run((c) => c.query(`INSERT INTO cell_stock(cell_block_id,warehouse_id,company_id,sku,qty)
        VALUES($1,$2,$3,$4,$5)`, [cell, warehouseId, company, sku, qty]));
    }
    const count = (t, lines, note) => api('POST', `/api/inventory/tasks/${t.id}/count`, worker,
      { lines, note, snapshotId: t.opened.snapshotId });
    const resolve = (t, decision = 'apply', token = owner) => api('POST', `/api/inventory/tasks/${t.id}/resolve`, token, { decision });
    const qty = async (cell) => Number((await run((c) => c.query(
      'SELECT COALESCE(SUM(qty),0) AS qty FROM cell_stock WHERE cell_block_id=$1', [cell]))).rows[0].qty);

    const catalog = must(await api('GET', '/api/inventory/products?q=SAME', worker));
    check('catalog keeps sellers of same SKU distinct', () => {
      assert.deepEqual(new Set(catalog.map((p) => p.companyId)), new Set([company, company2]));
      assert.ok(catalog.every((p) => p.companyName));
    });
    check('catalog is isolated to warehouse', () => assert.deepEqual(catalog.filter((p) => p.companyId === foreign), []));
    assert.deepEqual(must(await api('GET', '/api/inventory/products?q=FOREIGN', worker)), []);

    const initial = await task(cells[0]);
    for (const badLines of [
      [line(null)], [line(1, { companyId: foreign })], [line(1, { sku: 'FOREIGN' })],
      [line(1, { quality: 'invented' })], [line(1), line(1)], [line(1, { sku: 'UNKNOWN' })],
    ]) {
      check('invalid or foreign count rejected before stock change', () => {});
      assert.equal((await count(initial, badLines)).status, 400);
      assert.equal(await qty(cells[0]), 0);
    }
    must(await count(initial, [line(9)]));
    assert.equal(await qty(cells[0]), 0);
    const pending = must(await api('GET', '/api/inventory/tasks?status=waiting_owner', owner)).find((t) => t.id === initial.id);
    check('owner sees actual new line and seller before applying', () => {
      assert.equal(pending.counted[0].qty, 9); assert.equal(pending.counted[0].companyName, 'Test seller A');
      assert.equal(pending.counted[0].name, 'Test product SAME');
    });
    assert.equal((await resolve(initial, 'apply', worker)).status, 403);
    assert.equal((await resolve(initial, 'apply', accountB.token)).status, 404);
    must(await resolve(initial));
    check('new SKU in empty cell becomes physical stock only on owner decision', () => {});
    assert.equal(await qty(cells[0]), 9);
    assert.equal((await resolve(initial)).status, 409);
    assert.equal(await qty(cells[0]), 9);

    const zero = await task(cells[1]);
    must(await count(zero, [line(0, { sku: 'ZERO' })]));
    must(await resolve(zero, 'apply', manager));
    const stock = must(await api('GET', `/api/sellers/stock?companyId=${company}`, owner));
    check('explicit counted zero is known stock and leaves inventory trail', () => {
      const z = stock.find((p) => p.sku === 'ZERO');
      assert.equal(z.stockKnown, true); assert.equal(z.onHand, 0);
    });
    const zeroTrail = await run((c) => c.query(`SELECT * FROM stock_operations WHERE warehouse_id=$1 AND sku='ZERO' AND kind='inventory'`, [warehouseId]));
    assert.equal(zeroTrail.rows.length, 1); assert.equal(Number(zeroTrail.rows[0].qty), 0);
    assert.equal(zeroTrail.rows[0].details.resolvedByStaffKeyId, managerKey.id);
    const zeroTask = await run((c) => c.query('SELECT resolved_by_staff_key_id FROM inventory_tasks WHERE id=$1', [zero.id]));
    assert.equal(zeroTask.rows[0].resolved_by_staff_key_id, managerKey.id);

    // Deleting and restoring the same total must not fool the snapshot check.
    await insert(cells[2], 5);
    const aba = await task(cells[2]);
    await run(async (c) => {
      await c.query('DELETE FROM cell_stock WHERE cell_block_id=$1', [cells[2]]);
      await c.query(`INSERT INTO cell_stock(cell_block_id,warehouse_id,company_id,sku,qty)
        VALUES($1,$2,$3,'SAME',5)`, [cells[2], warehouseId, company]);
    });
    assert.equal((await count(aba, [line(5)])).status, 409);
    check('delete and insert with identical total invalidates open count', () => {});

    for (const [index, operation, remaining] of [[3, 'update', 20], [4, 'delete', 0], [5, 'insert', 8]]) {
      await insert(cells[index], 5);
      const t = await task(cells[index]);
      must(await count(t, [line(4)]));
      if (operation === 'insert') await insert(cells[index], 3);
      else await run((c) => c.query(operation === 'update'
        ? 'UPDATE cell_stock SET qty=20 WHERE cell_block_id=$1'
        : 'DELETE FROM cell_stock WHERE cell_block_id=$1', [cells[index]]));
      assert.equal((await resolve(t)).status, 409);
      assert.equal(await qty(cells[index]), remaining);
      check(`${operation} after count rejects owner apply and preserves current stock`, () => {});
      must(await resolve(t, 'recount'));
      const reopened = must(await api('POST', `/api/inventory/tasks/${t.id}/open`, worker));
      assert.equal(reopened.expected.reduce((sum, l) => sum + l.qty, 0), remaining);
    }

    const extra = await task(cells[6]);
    must(await count(extra, [], 'Работник отметил неуказанный товар'));
    assert.equal((await resolve(extra)).status, 409);
    must(await resolve(extra, 'recount'));
    check('unidentified found goods cannot be silently accepted as an empty cell', () => {});

    const twoWindows = await task(cells[9]);
    const newer = must(await api('POST', `/api/inventory/tasks/${twoWindows.id}/open`, worker));
    assert.notEqual(newer.snapshotId, twoWindows.opened.snapshotId);
    assert.equal((await count(twoWindows, [line(3)])).status, 409);
    twoWindows.opened = newer;
    must(await count(twoWindows, [line(3)]));
    check('reopening a task rejects the previous window snapshot', () => {});

    // Existing stock-row locks predate the revision trigger in shipping/move.
    await insert(cells[7], 5);
    const locked = await task(cells[7]);
    must(await count(locked, [line(4)]));
    let ready; let release;
    const isReady = new Promise((r) => { ready = r; });
    const released = new Promise((r) => { release = r; });
    const writer = run(async (c) => {
      await c.query('SELECT id FROM cell_stock WHERE cell_block_id=$1 FOR UPDATE', [cells[7]]);
      ready(); await released;
      await c.query('UPDATE cell_stock SET qty=qty-1 WHERE cell_block_id=$1', [cells[7]]);
    });
    await isReady;
    try { assert.equal((await resolve(locked)).status, 409); }
    finally { release(); await writer; }
    assert.equal(await qty(cells[7]), 4);
    check('concurrent picker holding a stock row causes 409 without deadlock or lost movement', () => {});

    // A new insertion cannot pass the parent lock while apply is in progress.
    const serial = await task(cells[8]);
    must(await count(serial, [line(7)]));
    let applied; let commit;
    const isApplied = new Promise((r) => { applied = r; });
    const canCommit = new Promise((r) => { commit = r; });
    const applying = run(async (c) => {
      await service.resolveTask(c, warehouseId, serial.id, { decision: 'apply', ownerId });
      applied(); await canCommit;
    });
    await isApplied;
    let inserted = false;
    const insertion = insert(cells[8], 3).then(() => { inserted = true; });
    try {
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(inserted, false, 'insertion bypassed the cell revision lock');
    } finally { commit(); await applying; await insertion; }
    assert.equal(await qty(cells[8]), 10);
    check('concurrent insertion serializes after accepted count, preserving both facts', () => {});

    console.log(`${passed} passed, 0 failed`);
  } finally { server.close(); }
})().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
