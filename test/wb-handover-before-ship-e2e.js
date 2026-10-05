// Поставка WB по шагам (владелец 05.10.2026): «Передать в доставку WB» на
// собранной поставке — WB закрывает её и выдаёт QR, потом «Уехала» — второй
// раз в WB не идём, потом «принята WB», когда WB принял все посылки.
// Сети нет: функции записи WB подменены.
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
  const calls = [];
  Object.assign(wbWrite, {
    createSupply: async (t, name) => { calls.push(['createSupply', name]); return 'WB-GI-900'; },
    addOrders: async () => true,
    supplyOrderIds: async () => ['90001', '90002'],
    orderStickers: async (t, ids) => ids.map((id) => ({ orderId: String(id), partA: '1', partB: '2', barcode: 'S' + id, file: 'c3Zn' })),
    setShipping: async (t, s, p) => { calls.push(['setShipping', p.date]); return true; },
    deliverSupply: async (t, s) => { calls.push(['deliverSupply', s]); return true; },
    supplyBarcode: async () => ({ barcode: 'WB-QR-900', file: 'cXI=' }),
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
    const owner = await must('POST', '/api/auth/owner/register', null, { name: 'Владелец', email: `handover-${Date.now()}@test.local`,
      password: 'synthetic-pass-123', warehouseName: 'Ромашка', city: 'Test' }, 201);
    const warehouseId = JSON.parse(Buffer.from(owner.token.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = await must('POST', '/api/sellers/companies', owner.token, { name: 'Продавец' }, 201);
    await run((q) => q.query(`INSERT INTO products(warehouse_id,company_id,sku,name) VALUES($1,$2,'HO-1','Товар')`, [warehouseId, company.id]));
    const order = async (externalId) => {
      const inv = await must('POST', '/api/invoices', owner.token, { companyId: company.id, number: 'WB-' + externalId, direction: 'out',
        items: [{ sku: 'HO-1', name: 'Товар', declaredQty: 1 }] }, 201);
      await run((q) => q.query(`UPDATE invoices SET source='wb', external_id=$2, mp_supplier_status='new' WHERE id=$1`, [inv.id, String(externalId)]));
      await run((q) => q.query(`UPDATE invoice_items SET mp_rid=$2 WHERE invoice_id=$1`, [inv.id, 'rid-' + externalId]));
      return inv;
    };
    const a = await order(90001);
    const b = await order(90002);
    await run((c) => credentials.save(c, warehouseId, { companyId: company.id, marketplace: 'wb', token: 'synthetic-write-token' }));
    await must('PATCH', `/api/marketplaces/${company.id}/wb/write`, owner.token, { enabled: true });
    await must('PATCH', '/api/warehouses/me', owner.token, { wbSupplyLabel: 'ФФ Ромашка' });
    const planned = '2099-12-31';
    const supply = await must('POST', '/api/supplies', owner.token, { invoiceIds: [a.id, b.id], marketplace: 'wb',
      shipDate: planned, shippingPointId: 100, destination: 'Пункт' }, 201);
    check('имя поставки на WB — подпись склада и наш номер', () => {
      assert.deepEqual(calls.find((c) => c[0] === 'createSupply'), ['createSupply', `ФФ Ромашка ${supply.number}`]);
    });

    const early = await api('POST', `/api/supplies/${supply.id}/marketplace/deliver`, owner.token);
    check('пока поставка собирается, передать в доставку нельзя', () => assert.equal(early.status, 409));

    // Собрано: поставка и заказы готовы (сборку проверяют свои тесты).
    await run((q) => q.query(`UPDATE invoices SET status='ready' WHERE supply_id=$1`, [supply.id]));
    await run((q) => q.query(`UPDATE supplies SET status='ready', ready_at=now() WHERE id=$1`, [supply.id]));
    calls.length = 0;
    const handed = await must('POST', `/api/supplies/${supply.id}/marketplace/deliver`, owner.token);
    const row = (await run((q) => q.query('SELECT status, mp_delivered_at, mp_barcode FROM supplies WHERE id=$1', [supply.id]))).rows[0];
    check('собранная поставка передаётся в доставку до отъезда, QR получен', () => {
      assert.ok(handed.delivered, JSON.stringify(handed));
      assert.equal(row.status, 'ready');
      assert.ok(row.mp_delivered_at);
      assert.equal(row.mp_barcode, 'WB-QR-900');
    });
    check('дата отгрузки на WB — плановая, раз она впереди', () => {
      assert.deepEqual(calls.find((c) => c[0] === 'setShipping'), ['setShipping', planned]);
    });
    const listed = (await must('GET', '/api/supplies', owner.token)).find((s) => s.id === supply.id);
    check('в списке видно, что поставка передана в доставку', () => assert.ok(listed.mp_delivered_at));

    calls.length = 0;
    const shipped = await must('POST', `/api/supplies/${supply.id}/ship`, owner.token, {});
    check('«Уехала» после передачи — второй раз в WB не идём', () => {
      assert.equal(shipped.status, 'shipped');
      assert.ok(!calls.some((c) => c[0] === 'deliverSupply'), JSON.stringify(calls));
      assert.ok(shipped.marketplace && shipped.marketplace.alreadyDelivered, JSON.stringify(shipped.marketplace));
    });

    await run((q) => q.query(`UPDATE invoices SET mp_closed_at=now(), mp_close_reason='fulfilled' WHERE id=$1`, [a.id]));
    const half = (await must('GET', '/api/supplies', owner.token)).find((s) => s.id === supply.id);
    await run((q) => q.query(`UPDATE invoices SET mp_closed_at=now(), mp_close_reason='fulfilled' WHERE id=$1`, [b.id]));
    const all = (await must('GET', '/api/supplies', owner.token)).find((s) => s.id === supply.id);
    check('принято WB считается по посылкам: 1 из 2, потом 2 из 2', () => {
      assert.equal(half.accepted, 1);
      assert.equal(all.accepted, 2);
      assert.equal(all.orders, 2);
    });
    const seller = await must('GET', `/api/sellers/supplies?companyId=${company.id}`, owner.token);
    check('у продавца поставка — «Принята WB»', () => {
      assert.equal(seller.rows.find((s) => s.id === supply.id).statusName, 'Принята WB');
    });
  } catch (e) {
    failed += 1; console.log('FAIL тест упал: ' + e.stack);
  } finally {
    server.close(); await pool.end();
    console.log(`\n${count} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})();
