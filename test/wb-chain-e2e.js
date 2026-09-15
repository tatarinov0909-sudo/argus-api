// The owner's chain on synthetic WB orders, end to end:
// order arrives → manager builds a supply → loaders pick → WB changes status
// under our feet → supply leaves. Isolated test database only, no WB network.
const assert = require('node:assert/strict');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !/test/i.test(new URL(dbUrl).pathname) || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Select a separate test DATABASE_URL and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const { reconcile } = require('../src/marketplaces/statuses');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let count = 0;
  const check = (name, fn) => { fn(); count += 1; console.log('PASS ' + name); };
  const api = async (method, path, token, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const must = async (method, path, token, body, status = 200) => {
    const r = await api(method, path, token, body); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body;
  };
  try {
    const stamp = Date.now();
    const owner = await must('POST', '/api/auth/owner/register', null, { name: 'Chain owner', email: `chain-${stamp}@test.local`,
      password: 'synthetic-pass-123', warehouseName: 'Chain test', city: 'Test' }, 201);
    const warehouseId = JSON.parse(Buffer.from(owner.token.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = await must('POST', '/api/sellers/companies', owner.token, { name: 'Chain seller' }, 201);
    const staff = await must('POST', '/api/staff', owner.token, { name: 'Chain worker' }, 201);
    const worker = await must('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code });
    const mgrKey = await must('POST', '/api/staff', owner.token, { name: 'Chain manager', kind: 'manager' }, 201);
    const manager = await must('POST', '/api/auth/staff/login', null, { keyCode: mgrKey.key_code });
    await must('POST', '/api/cells/rows', owner.token, { configs: [{ rackCount: 2, tierCount: 1 }] }, 201);
    const cell = (await must('GET', '/api/cells/rows', owner.token)).flatMap((r) => r.blocks)[0].id;
    await run((q) => q.query(`INSERT INTO products(warehouse_id,company_id,sku,name) VALUES($1,$2,'CH-1','Chain item')`, [warehouseId, company.id]));
    const receipt = await must('POST', '/api/invoices', owner.token, { companyId: company.id, number: 'CH-IN',
      items: [{ sku: 'CH-1', name: 'Chain item', declaredQty: 50 }] }, 201);
    await must('POST', '/api/receiving', worker.token, { invoiceItemId: receipt.items[0].id, acceptedQty: 50, cellBlockId: cell }, 201);

    // 1. Orders arrive from WB: four new, one someone already confirmed in the WB cabinet.
    const wbOrder = async (id, supplierStatus = 'new') => {
      const inv = await must('POST', '/api/invoices', owner.token, { companyId: company.id, number: 'WB-' + id, direction: 'out',
        items: [{ sku: 'CH-1', name: 'Chain item', declaredQty: 1 }] }, 201);
      await run((q) => q.query(`UPDATE invoices SET source='wb', external_id=$2, mp_supplier_status=$3 WHERE id=$1`, [inv.id, String(id), supplierStatus]));
      await run((q) => q.query(`UPDATE invoice_items SET mp_rid=$2 WHERE invoice_id=$1`, [inv.id, 'rid-' + id]));
      return inv;
    };
    const [a, b, c, d] = [await wbOrder(70001), await wbOrder(70002), await wbOrder(70003), await wbOrder(70004)];
    const confirmed = await wbOrder(70009, 'confirm');

    const queue = (await must('GET', '/api/supplies/pending', manager.token)).find((p) => p.companyId === company.id);
    const rows = await must('GET', `/api/supplies/pending/${company.id}`, manager.token);
    check('the manager sees new WB orders apart from ones already confirmed in the WB cabinet', () => {
      assert.equal(queue.orders, 4); assert.equal(queue.wbConfirmed, 1);
      const x = rows.find((r) => r.id === confirmed.id);
      assert.equal(x.wbConfirmed, true); assert.equal(x.ready, false);
    });
    const refused = await api('POST', '/api/supplies', manager.token, { invoiceIds: [a.id, confirmed.id] });
    check('an order confirmed in the WB cabinet cannot go into an Argus supply a second time', () => {
      assert.equal(refused.status, 409); assert.match(refused.body.error, /подтверждён в кабинете WB/);
    });

    // 2. Loaders cannot start on an order the manager has not released.
    const early = await api('POST', '/api/shipping', worker.token, { invoiceItemId: a.items[0].id, pickedQty: 1, cellBlockId: cell });
    const workerList = await must('GET', '/api/invoices?direction=out', worker.token);
    check('a WB order outside a supply is neither listed for nor pickable by a worker', () => {
      assert.equal(early.status, 409);
      assert.ok(!workerList.some((r) => r.id === a.id));
    });

    // 3. The manager builds the supply.
    const supply = await must('POST', '/api/supplies', manager.token, { invoiceIds: [a.id, b.id, c.id, d.id], marketplace: 'wb' }, 201);
    const listed = await must('GET', '/api/invoices?direction=out', worker.token);
    const sheet = await must('GET', '/api/shipping/pick-list', worker.token);
    check('after the supply is built, its orders reach the worker and nothing else from WB does', () => {
      assert.ok([a, b, c, d].every((o) => listed.some((r) => r.id === o.id)));
      assert.ok(!listed.some((r) => r.id === confirmed.id));
      assert.equal(sheet.orders.length, 4);
    });
    const sellerKey = await must('POST', `/api/sellers/companies/${company.id}/keys`, owner.token, {}, 201);
    const seller = await must('POST', '/api/auth/seller/login', null, { keyCode: sellerKey.key_code, name: 'Chain seller' });
    const sellerOrders = await must('GET', '/api/sellers/orders', seller.token);
    check('the seller can tell an order in a supply from a new one', () => {
      assert.equal(sellerOrders.rows.find((r) => r.id === a.id).in_supply, true);
      assert.equal(sellerOrders.rows.find((r) => r.id === confirmed.id).in_supply, false);
    });

    // 4. Loaders pick a and b; the other two are still on the floor.
    for (const o of [a, b]) await must('POST', '/api/shipping', worker.token, { invoiceItemId: o.items[0].id, pickedQty: 1, cellBlockId: cell }, 201);

    // 5. WB moves under our feet: c is canceled before anyone picked it, b is
    // canceled after it was picked, a is merely handed over to delivery.
    const statuses = async (list) => {
      await run((q) => q.query(`UPDATE invoices SET mp_status_attempted_at=NULL WHERE warehouse_id=$1`, [warehouseId]));
      return run((q) => reconcile(q, warehouseId, company.id, 'synthetic', { fetchStatuses: async () => list }));
    };
    await statuses([
      { id: 70001, supplierStatus: 'complete', wbStatus: 'waiting' },
      { id: 70002, supplierStatus: 'cancel', wbStatus: 'canceled_by_client' },
      { id: 70003, supplierStatus: 'cancel', wbStatus: 'canceled_by_client' },
      { id: 70004, supplierStatus: 'new', wbStatus: 'waiting' },
    ]);
    const state = await run((q) => q.query(`SELECT id, supply_id, mp_closed_at FROM invoices WHERE id=ANY($1::uuid[])`, [[a.id, b.id, c.id, d.id]]));
    const byId = Object.fromEntries(state.rows.map((r) => [r.id, r]));
    check('handing a supply order to WB delivery is its normal course: nothing closes, nothing blocks', () => {
      assert.equal(byId[a.id].mp_closed_at, null); assert.equal(byId[a.id].supply_id, supply.id);
    });
    check('canceled orders leave the supply by themselves, picked or not', () => {
      assert.equal(byId[b.id].supply_id, null); assert.equal(byId[c.id].supply_id, null);
      assert.ok(byId[b.id].mp_closed_at && byId[c.id].mp_closed_at);
    });
    const printable = await api('GET', `/api/supplies/${supply.id}`, owner.token);
    const issues = await must('GET', '/api/marketplaces/reconciliation', owner.token);
    check('the rest of the supply still prints, and only the picked cancellation needs a person', () => {
      assert.equal(printable.status, 200); assert.equal(printable.body.totals.orders, 2);
      assert.deepEqual(issues.rows.map((r) => r.id), [b.id]);
    });
    const pending = (await must('GET', '/api/journal', owner.token)).filter((j) => j.agent === 'Обмен с WB' && j.status === 'pending');
    check('an unpicked cancellation does not wait for anyone in the journal', () => {
      assert.ok(!pending.some((j) => j.invoice_id === c.id)); assert.ok(pending.some((j) => j.invoice_id === b.id));
    });
    const ownerList = await must('GET', '/api/invoices?direction=out', owner.token);
    check('the untouched cancellation disappears from the warehouse lists', () => {
      assert.ok(!ownerList.some((r) => r.id === c.id)); assert.ok(ownerList.some((r) => r.id === b.id));
    });

    // 6. The last order is picked: the supply becomes ready by itself and leaves as a whole.
    const notYet = await api('POST', `/api/supplies/${supply.id}/ship`, manager.token);
    await must('POST', '/api/shipping', worker.token, { invoiceItemId: d.items[0].id, pickedQty: 1, cellBlockId: cell }, 201);
    const readyRow = (await must('GET', '/api/supplies', manager.token)).find((s) => s.id === supply.id);
    const single = await api('POST', `/api/shipping/${d.id}/ship`, worker.token);
    const shipped = await api('POST', `/api/supplies/${supply.id}/ship`, manager.token, { destination: 'СЦ' });
    const after = await run((q) => q.query(`SELECT id, status FROM invoices WHERE id=ANY($1::uuid[])`, [[a.id, d.id]]));
    check('a supply leaves only when every order is picked, and the manager marks it', () => {
      assert.equal(notYet.status, 409);
      assert.equal(readyRow.status, 'ready'); assert.equal(readyRow.picked, 2);
      assert.equal(single.status, 409);
      assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
      assert.ok(after.rows.every((r) => r.status === 'shipped'));
    });

    // 7. WB statuses for orders the warehouse never touched are not asked again.
    await wbOrder(70010);
    await statuses([{ id: 70010, supplierStatus: 'complete', wbStatus: 'sorted' }]);
    await run((q) => q.query(`UPDATE invoices SET mp_status_attempted_at=NULL WHERE warehouse_id=$1`, [warehouseId]));
    let asked = [];
    await run((q) => reconcile(q, warehouseId, company.id, 'synthetic', { fetchStatuses: async (_, ids) => { asked = ids; return []; } }));
    check('a delivered order nobody picked is closed once and never polled again', () => {
      assert.ok(!asked.includes('70010'), JSON.stringify(asked));
    });

    // 8. A manager without the «clients» right cannot read seller login keys.
    const companies = await must('GET', '/api/sellers/companies', manager.token);
    check('seller keys are masked for a manager without the clients right', () => {
      const keys = companies.find((x) => x.id === company.id).keys;
      assert.ok(keys.length && keys.every((k) => k.keyCode.includes('••')));
    });
    const ownerCompanies = await must('GET', '/api/sellers/companies', owner.token);
    check('the owner still sees them in full', () => {
      assert.equal(ownerCompanies.find((x) => x.id === company.id).keys[0].keyCode, sellerKey.key_code);
    });

    console.log(`\n${count} chain checks passed`);
  } finally {
    await new Promise((r) => server.close(r)); await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
