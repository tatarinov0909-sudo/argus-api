// Владелец 06.10.2026: «Уехала» у поставки WB — только после «Передать в
// доставку WB» (QR); «Доступно» не считает свободным то, что едет на WB;
// складу видно «На WB» и расхождение с «Доступно», на «Главной» —
// уведомление; продавцу — приёмка WB по поставке. Сеть WB подменена.
const assert = require('node:assert/strict');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !/test/i.test(new URL(dbUrl).pathname) || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Select a separate test DATABASE_URL and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const credentials = require('../src/marketplaces/credentials');
const wbWrite = require('../src/marketplaces/wbWrite');

let count = 0;
let failed = 0;
const check = (name, fn) => {
  try { fn(); count += 1; console.log('PASS ' + name); } catch (e) { failed += 1; console.log('FAIL ' + name + '\n  ' + e.message); }
};
(async () => {
  Object.assign(wbWrite, {
    createSupply: async () => 'WB-GI-610',
    addOrders: async () => true,
    supplyOrderIds: async () => ['61001', '61002'],
    orderStickers: async (t, ids) => ids.map((id) => ({ orderId: String(id), partA: '1', partB: '2', barcode: 'S' + id, file: 'c3Zn' })),
    setShipping: async () => true,
    deliverSupply: async () => true,
    supplyBarcode: async () => ({ barcode: 'WB-QR-610', file: 'cXI=' }),
  });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, token, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const must = async (method, path, token, body, status = 200) => {
    const r = await api(method, path, token, body);
    assert.equal(r.status, status, `${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  try {
    const owner = await must('POST', '/api/auth/owner/register', null, { name: 'Владелец', email: `transit-${Date.now()}@test.local`,
      password: 'synthetic-pass-123', warehouseName: 'Ромашка', city: 'Test' }, 201);
    const warehouseId = JSON.parse(Buffer.from(owner.token.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = await must('POST', '/api/sellers/companies', owner.token, { name: 'Продавец' }, 201);
    // «Всего» — 10 (учёт из 1С).
    await run((q) => q.query(`INSERT INTO products(warehouse_id,company_id,sku,name,stock_qty_1c,stock_at)
      VALUES($1,$2,'TR-1','Гантели',10,now())`, [warehouseId, company.id]));
    const order = async (externalId) => {
      const inv = await must('POST', '/api/invoices', owner.token, { companyId: company.id, number: 'WB-' + externalId, direction: 'out',
        items: [{ sku: 'TR-1', name: 'Гантели', declaredQty: 1 }] }, 201);
      await run((q) => q.query(`UPDATE invoices SET source='wb', external_id=$2, mp_supplier_status='new', mp_warehouse_id='501' WHERE id=$1`,
        [inv.id, String(externalId)]));
      await run((q) => q.query(`UPDATE invoice_items SET mp_rid=$2, mp_chrt_id='777' WHERE invoice_id=$1`, [inv.id, 'rid-' + externalId]));
      return inv;
    };
    const a = await order(61001);
    const b = await order(61002);
    await run((c) => credentials.save(c, warehouseId, { companyId: company.id, marketplace: 'wb', token: 'synthetic-write-token' }));
    await must('PATCH', `/api/marketplaces/${company.id}/wb/write`, owner.token, { enabled: true });
    const supply = await must('POST', '/api/supplies', owner.token, { invoiceIds: [a.id, b.id], marketplace: 'wb',
      shipDate: '2099-12-31', shippingPointId: 100, destination: 'Пункт' }, 201);
    await run((q) => q.query(`UPDATE invoices SET status='ready' WHERE supply_id=$1`, [supply.id]));
    await run((q) => q.query(`UPDATE supplies SET status='ready', ready_at=now() WHERE id=$1`, [supply.id]));

    const listed = (await must('GET', '/api/supplies', owner.token)).find((s) => s.id === supply.id);
    const early = await api('POST', `/api/supplies/${supply.id}/ship`, owner.token, {});
    check('«Уехала» без QR поставки WB нельзя', () => {
      assert.equal(listed.mp_write, true);
      assert.equal(early.status, 409, JSON.stringify(early.body));
      assert.match(early.body.error || early.body.message || '', /Передать в доставку WB/);
    });
    await must('POST', `/api/supplies/${supply.id}/marketplace/deliver`, owner.token);
    const shipped = await must('POST', `/api/supplies/${supply.id}/ship`, owner.token, {});
    check('после «Передать в доставку WB» поставка уезжает', () => assert.equal(shipped.status, 'shipped'));

    const c = await order(61003);   // новый заказ, ещё не в поставке
    // На наших складах WB выставлено 6 + 3 = 9, свободно 10 − 1 − 2 = 7.
    await run((q) => q.query(`INSERT INTO seller_wb_warehouses(warehouse_id,company_id,mp_warehouse_id,name,ours)
      VALUES($1,$2,'501','Склад А',true),($1,$2,'502','Склад Б',true),($1,$2,'503','Чужой',false)`, [warehouseId, company.id]));
    await run((q) => q.query(`INSERT INTO wb_stock_levels(warehouse_id,company_id,mp_warehouse_id,chrt_id,amount)
      VALUES($1,$2,'501','777',6),($1,$2,'502','777',3),($1,$2,'503','777',50)`, [warehouseId, company.id]));

    const row = (await must('GET', `/api/sellers/stock?companyId=${company.id}`, owner.token)).find((r) => r.sku === 'TR-1');
    check('«Доступно» = Всего − Заказано − В сборке − В пути', () => {
      assert.equal(row.total, 10);
      assert.equal(row.inTransit, 2);
      assert.equal(row.orderedNotInSupply, 1);
      assert.equal(row.sellerAvailable, 7);
      assert.equal(row.shortage, false);
    });
    check('складу видно «На WB» по своим складам WB и где снять лишнее', () => {
      assert.equal(row.wbListed, 9);
      assert.equal(row.wbOver, 2);
      assert.deepEqual(row.wbTop, { name: 'Склад А', amount: 6 });
    });
    const sellerView = await must('GET', `/api/sellers/stock?companyId=${company.id}&view=seller`, owner.token);
    check('у продавца то же «Доступно»', () => assert.equal(sellerView.rows.find((r) => r.sku === 'TR-1').available, 7));
    const summary = (await must('GET', '/api/sellers/stock-summary', owner.token)).sellers.find((s) => s.companyId === company.id);
    const today = await must('GET', '/api/alerts/today', owner.token);
    check('сводка и «Главная» говорят о расхождении с WB', () => {
      assert.equal(summary.wbOver, 1);
      assert.equal(summary.available, 7);
      assert.deepEqual(today.exchange.wbOver, [{ companyId: company.id, name: 'Продавец', count: 1 }]);
    });

    await run((q) => q.query(`UPDATE invoices SET mp_closed_at=now(), mp_close_reason='fulfilled' WHERE id=$1`, [a.id]));
    const half = (await must('GET', `/api/sellers/supplies?companyId=${company.id}`, owner.token)).rows.find((s) => s.id === supply.id);
    await run((q) => q.query(`UPDATE invoices SET mp_closed_at=now(), mp_close_reason='fulfilled' WHERE id=$1`, [b.id]));
    const all = (await must('GET', `/api/sellers/supplies?companyId=${company.id}`, owner.token)).rows.find((s) => s.id === supply.id);
    check('продавцу — приёмка WB по поставке: 1 принято, 1 в пути, потом все', () => {
      assert.equal(half.ordersAccepted, 1);
      assert.equal(half.ordersInTransit, 1);
      assert.equal(half.statusName, 'Уехала');
      assert.equal(all.ordersAccepted, 2);
      assert.equal(all.ordersInTransit, 0);
      assert.equal(all.statusName, 'Принята WB');
    });
    const after = (await must('GET', `/api/sellers/stock?companyId=${company.id}`, owner.token)).find((r) => r.sku === 'TR-1');
    check('принятое WB больше не «В пути»', () => assert.equal(after.inTransit, 0));
    void c;
  } catch (e) {
    failed += 1; console.log('FAIL тест упал: ' + e.stack);
  } finally {
    server.close(); await pool.end();
    console.log(`\n${count} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})();
