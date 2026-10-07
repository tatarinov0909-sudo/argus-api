// WB принял посылку из поставки, которую Аргус сам передал в доставку WB, а
// «Уехала» в Аргусе не нажали (06.10.2026: шесть поставок, 268 заказов).
// Поставка должна уехать по данным WB и сохранить свои заказы, а не терять
// их по одному со строкой «на сверку». Сети нет: функции WB подменены.
const assert = require('node:assert/strict');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !/test/i.test(new URL(dbUrl).pathname) || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Select a separate test DATABASE_URL and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const credentials = require('../src/marketplaces/credentials');
const wbWrite = require('../src/marketplaces/wbWrite');
const { reconcile } = require('../src/marketplaces/statuses');

let count = 0;
let failed = 0;
const check = (name, fn) => {
  try { fn(); count += 1; console.log('PASS ' + name); } catch (e) { failed += 1; console.log('FAIL ' + name + '\n  ' + e.message); }
};
(async () => {
  Object.assign(wbWrite, {
    createSupply: async () => 'WB-GI-777',
    addOrders: async () => true,
    supplyOrderIds: async () => ['77001', '77002'],
    orderStickers: async (t, ids) => ids.map((id) => ({ orderId: String(id), partA: '1', partB: '2', barcode: 'S' + id, file: 'c3Zn' })),
    setShipping: async () => true,
    deliverSupply: async () => true,
    supplyBarcode: async () => ({ barcode: 'WB-QR-777', file: 'cXI=' }),
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
    const owner = await must('POST', '/api/auth/owner/register', null, { name: 'Владелец', email: `accepted-${Date.now()}@test.local`,
      password: 'synthetic-pass-123', warehouseName: 'Ромашка', city: 'Test' }, 201);
    const token = owner.token;
    const warehouseId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = (await must('POST', '/api/sellers/companies', token, { name: 'Продавец' }, 201)).id;
    await must('POST', '/api/products', token, { sku: 'AC-1', name: 'Товар', companyId: company }, 201);
    await must('POST', '/api/cells/rows', token, { configs: [{ rackCount: 1, tierCount: 1 }] }, 201);
    const cell = (await must('GET', '/api/cells/rows', token)).flatMap((r) => r.blocks)[0].id;
    const staff = await must('POST', '/api/staff', token, { name: 'Грузчик' }, 201);
    const worker = (await must('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code })).token;
    const receipt = await must('POST', '/api/invoices', token, { companyId: company, number: 'IN-AC',
      items: [{ sku: 'AC-1', name: 'Товар', declaredQty: 10 }] }, 201);
    await must('POST', `/api/receiving/session/${receipt.id}/start`, worker, {}, 201);
    await must('POST', '/api/receiving', worker, { invoiceItemId: receipt.items[0].id, acceptedQty: 10, cellBlockId: cell }, 201);

    const order = async (externalId) => {
      const inv = await must('POST', '/api/invoices', token, { companyId: company, number: 'WB-' + externalId, direction: 'out',
        items: [{ sku: 'AC-1', name: 'Товар', declaredQty: 1 }] }, 201);
      await run((q) => q.query(`UPDATE invoices SET source='wb', external_id=$2, mp_supplier_status='new' WHERE id=$1`, [inv.id, String(externalId)]));
      await run((q) => q.query(`UPDATE invoice_items SET mp_rid=$2 WHERE invoice_id=$1`, [inv.id, 'rid-' + externalId]));
      return inv;
    };
    const pickAll = async (supplyId, orders) => {
      await must('POST', `/api/shipping/assembly/${supplyId}/start`, worker, {}, 201);
      for (const o of orders) {
        await must('POST', '/api/shipping', worker, { invoiceItemId: o.items[0].id, pickedQty: 1, cellBlockId: cell, isFinal: true }, 201);
      }
    };
    const statuses = (map) => async (_, ids) => ids.filter((id) => map[id]).map((id) => ({ id: Number(id), ...map[id] }));
    const poll = async (map) => {
      await run((q) => q.query('UPDATE invoices SET mp_status_attempted_at = NULL WHERE warehouse_id = $1', [warehouseId]));
      return run((q) => reconcile(q, warehouseId, company, 'synthetic-token', { fetchStatuses: statuses(map) }));
    };

    // ---------- Поставка передана в WB через Аргус, «Уехала» не нажали ----------
    const a = await order(77001);
    const b = await order(77002);
    await run((c) => credentials.save(c, warehouseId, { companyId: company, marketplace: 'wb', token: 'synthetic-write-token' }));
    await must('PATCH', `/api/marketplaces/${company}/wb/write`, token, { enabled: true });
    const supply = await must('POST', '/api/supplies', token, { invoiceIds: [a.id, b.id], marketplace: 'wb',
      shipDate: '2099-12-31', shippingPointId: 100, destination: 'Пункт' }, 201);
    await pickAll(supply.id, [a, b]);
    const handed = await must('POST', `/api/supplies/${supply.id}/marketplace/deliver`, token);
    const deliveredAt = (await run((q) => q.query('SELECT mp_delivered_at FROM supplies WHERE id=$1', [supply.id]))).rows[0].mp_delivered_at;
    check('собранная поставка передана в доставку WB, «Уехала» не нажата', () => {
      assert.ok(handed.delivered, JSON.stringify(handed));
      assert.ok(deliveredAt);
    });

    const first = await poll({ 77001: { supplierStatus: 'complete', wbStatus: 'sorted' }, 77002: { supplierStatus: 'confirm', wbStatus: 'waiting' } });
    const sup = (await run((q) => q.query('SELECT status, shipped_at FROM supplies WHERE id=$1', [supply.id]))).rows[0];
    const ords = (await run((q) => q.query(
      'SELECT number, status, supply_id, shipped_at, mp_closed_at, mp_close_reason FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY number',
      [[a.id, b.id]]))).rows;
    const journal = (await run((q) => q.query(
      `SELECT action_text, status FROM journal_entries WHERE warehouse_id = $1 AND agent = 'Обмен с WB' ORDER BY created_at`,
      [warehouseId]))).rows;
    check('WB принял посылку — поставка уехала сама, время отъезда — передача в доставку WB', () => {
      assert.equal(sup.status, 'shipped');
      assert.equal(new Date(sup.shipped_at).getTime(), new Date(deliveredAt).getTime());
    });
    check('оба заказа остались в поставке и уехали; принятый WB закрыт, второй — в пути', () => {
      for (const o of ords) { assert.equal(o.supply_id, supply.id); assert.equal(o.status, 'shipped'); }
      assert.equal(ords[0].mp_close_reason, 'fulfilled'); assert.ok(ords[0].mp_closed_at);
      assert.equal(ords[1].mp_closed_at, null);
      assert.equal(first.conflicts, 0);
    });
    check('в журнале одна строка про поставку и ни одной «на сверку»', () => {
      assert.equal(journal.filter((j) => /уехала — отмечено по данным WB/.test(j.action_text)).length, 1);
      assert.ok(journal.some((j) => j.action_text.includes(`«${supply.number}»`) && j.action_text.includes('2 заказа остаются')));
      assert.equal(journal.filter((j) => j.status === 'pending').length, 0);
    });
    const inside = await must('GET', `/api/supplies/${supply.id}`, token);
    const stock = (await must('GET', `/api/sellers/stock?companyId=${company}`, token));
    const row = (stock.rows || stock).find((r) => r.sku === 'AC-1');
    check('«Что внутри» показывает товар; у продавца «В сборке» 0, «В пути» 1', () => {
      assert.equal(inside.packing.length, 2);
      assert.equal(row.inAssembly, 0);
      assert.equal(row.inTransit, 1);
    });

    await poll({ 77002: { supplierStatus: 'complete', wbStatus: 'sorted' } });
    const seller = await must('GET', `/api/sellers/supplies?companyId=${company}`, token);
    const mine = seller.rows.find((s) => s.id === supply.id);
    check('WB принял вторую посылку — у продавца поставка «Принята WB», 2 заказа', () => {
      assert.ok(mine, 'поставка видна продавцу');
      assert.equal(mine.orders, 2);
      assert.equal(mine.statusName, 'Принята WB');
    });

    // ---------- Собрали в Аргусе, в доставку передавали в кабинете WB ----------
    // Владелец 07.10: «поставку создали через Аргус, а всё остальное — не
    // через нас». Заказ не вынимается, поставка уезжает, сверки нет.
    const c = await order(77003);
    const local = await must('POST', '/api/supplies', token, { invoiceIds: [c.id], marketplace: 'wb',
      shipDate: '2099-12-31', shippingPointId: 100, destination: 'Пункт' }, 201);
    await run((q) => q.query('UPDATE supplies SET mp_supply_id = NULL WHERE id = $1', [local.id]));
    await pickAll(local.id, [c]);
    await poll({ 77003: { supplierStatus: 'complete', wbStatus: 'sorted' } });
    const lc = (await run((q) => q.query('SELECT status, supply_id, mp_closed_at FROM invoices WHERE id=$1', [c.id]))).rows[0];
    const ls = (await run((q) => q.query('SELECT status, shipped_at FROM supplies WHERE id=$1', [local.id]))).rows[0];
    const pending = (await run((q) => q.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE warehouse_id=$1 AND agent='Обмен с WB' AND status='pending' AND invoice_id=$2`,
      [warehouseId, c.id]))).rows[0].n;
    check('передали в доставку не через Аргус — поставка всё равно уехала и не опустела, сверки нет', () => {
      assert.equal(ls.status, 'shipped'); assert.ok(ls.shipped_at);
      assert.equal(lc.status, 'shipped'); assert.equal(lc.supply_id, local.id); assert.ok(lc.mp_closed_at);
      assert.equal(pending, 0);
    });

    // ---------- Создали в Аргусе, собирали и отправляли через кабинет WB ----------
    const d = await order(77004);
    const e = await order(77005);
    const outside = await must('POST', '/api/supplies', token, { invoiceIds: [d.id, e.id], marketplace: 'wb',
      shipDate: '2099-12-31', shippingPointId: 100, destination: 'Пункт' }, 201);
    await poll({ 77004: { supplierStatus: 'complete', wbStatus: 'sorted' }, 77005: { supplierStatus: 'confirm', wbStatus: 'waiting' } });
    const half = (await run((q) => q.query(
      `SELECT s.status, (SELECT count(*)::int FROM invoices i WHERE i.supply_id = s.id) AS n,
              (SELECT count(*)::int FROM invoices i WHERE i.supply_id = s.id AND i.status = 'shipped') AS gone
         FROM supplies s WHERE s.id = $1`, [outside.id]))).rows[0];
        check('WB принял один заказ из несобранной в Аргусе поставки — он уехал и остался в ней, второй ждёт', () => {
      assert.equal(half.n, 2); assert.equal(half.gone, 1); assert.equal(half.status, 'collecting');
    });
    const twice = await api('POST', '/api/shipping', worker, { invoiceItemId: d.items[0].id, pickedQty: 1, cellBlockId: cell, isFinal: true });
    check('уехавший заказ грузчику второй раз не собрать', () => assert.equal(twice.status, 409));
    await poll({ 77005: { supplierStatus: 'complete', wbStatus: 'sorted' } });
    const full = (await run((q) => q.query(
      `SELECT s.status, (SELECT count(*)::int FROM invoices i WHERE i.supply_id = s.id) AS n FROM supplies s WHERE s.id = $1`,
      [outside.id]))).rows[0];
    const lines = (await run((q) => q.query(
      `SELECT action_text, status FROM journal_entries WHERE warehouse_id = $1 AND agent = 'Обмен с WB' AND entity_id = $2 ORDER BY created_at`,
      [warehouseId, outside.id]))).rows.filter((l) => /WB принял/.test(l.action_text));
    const stock2 = (await must('GET', `/api/sellers/stock?companyId=${company}`, token));
    const row2 = (stock2.rows || stock2).find((r) => r.sku === 'AC-1');
    const sellerSupplies = await must('GET', `/api/sellers/supplies?companyId=${company}`, token);
    const theirs = sellerSupplies.rows.find((s) => s.id === outside.id);
    check('WB принял все — поставка уехала с обоими заказами; продавец видит 2 заказа, «В сборке» 0', () => {
      assert.equal(full.status, 'shipped'); assert.equal(full.n, 2);
      assert.ok(theirs, 'поставка видна продавцу'); assert.equal(theirs.orders, 2);
      assert.equal(row2.inAssembly, 0);
    });
    check('журнал: по строке на проход, без «на сверку»; сказано, что собирали не в Аргусе', () => {
      assert.equal(lines.length, 2);
      assert.ok(lines.every((l) => l.status === 'auto'));
      assert.ok(/уехала — отмечено по данным WB/.test(lines[1].action_text), lines[1].action_text);
      assert.ok(/собирали не в Аргусе/.test(lines[1].action_text), lines[1].action_text);
    });
  } catch (e) {
    failed += 1; console.log('FAIL тест упал: ' + e.stack);
  } finally {
    server.close(); await pool.end();
    console.log(`\n${count} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})();
