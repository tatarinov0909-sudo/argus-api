// «Товары» продавца: что стоит за числами «Заказано», «В сборке», «В пути»
// (задание 27.09.2026). Список заказов под числом обязан давать ровно это
// число — во всех судьбах заказа: ждёт поставки, в поставке, отобран без
// поставки, уехал, принят WB, отменён, отменён после отбора.
// Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Seller product orders E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');

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
      name: 'Numbers test', email: `numbers-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Numbers test', city: 'Test',
    }), 201).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Числа Тест' }), 201).id;
    for (const [sku, name] of [['P-1', 'Батончик'], ['P-2', 'Паста']]) {
      must(await api('POST', '/api/products', owner, { sku, name, companyId: company }), 201);
    }
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 2, tierCount: 1 }] }), 201);
    const cell = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks)[0].id;
    const staff = must(await api('POST', '/api/staff', owner, { name: 'Грузчик' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code })).token;
    const key = must(await api('POST', `/api/sellers/companies/${company}/keys`, owner, {}), 201);
    const seller = must(await api('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Продавец' })).token;
    const inbound = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'IN-1',
      items: [{ sku: 'P-1', name: 'Батончик', declaredQty: 40 }, { sku: 'P-2', name: 'Паста', declaredQty: 5 }] }), 201);
    // «Начать приёмку» — без захода сервер приход не принимает (28.09.2026).
    await api('POST', `/api/receiving/session/${inbound.id}/start`, worker, {});
    must(await api('POST', '/api/receiving', worker, { invoiceItemId: inbound.items[0].id, acceptedQty: 40, cellBlockId: cell }), 201);
    // «Начать приёмку» — без захода сервер приход не принимает (28.09.2026).
    await api('POST', `/api/receiving/session/${inbound.id}/start`, worker, {});
    must(await api('POST', '/api/receiving', worker, { invoiceItemId: inbound.items[1].id, acceptedQty: 5, cellBlockId: cell }), 201);

    let n = 0;
    async function order(qty, { wb = true, sku = 'P-1' } = {}) {
      n += 1;
      const o = must(await api('POST', '/api/invoices', owner, { companyId: company, number: `N-${n}`, direction: 'out',
        items: [{ sku, name: sku === 'P-1' ? 'Батончик' : 'Паста', declaredQty: qty }] }), 201);
      if (wb) {
        await run((c) => c.query(`UPDATE invoices SET source = 'wb', external_id = $2 WHERE id = $1`, [o.id, `N-${n}`]));
        await run((c) => c.query(`UPDATE invoice_items SET mp_rid = 'rid-' || id WHERE invoice_id = $1`, [o.id]));
      }
      return o;
    }
    const supplyOf = async (orders) => {
      const s = must(await api('POST', '/api/supplies', owner, { invoiceIds: orders.map((o) => o.id), marketplace: 'wb' }), 201);
      // «Начать сборку» — без захода сервер сборку поставки не принимает (29.09.2026).
      must(await api('POST', `/api/shipping/assembly/${s.id}/start`, worker, {}), 201);
      return s;
    };
    const pickAll = async (supply, qty) => must(await api('POST', '/api/shipping/product', worker,
      { supplyId: supply.id, sku: 'P-1', cellBlockId: cell, pickedQty: qty }), 201);

    const queued = await order(1);                          // ждёт поставки → «Заказано»
    const inSupply = await order(2); await supplyOf([inSupply]);   // в поставке → «В сборке»
    const local = await order(3, { wb: false });            // из 1С, отобрано без поставки → «В сборке»
    must(await api('POST', '/api/shipping', worker, { invoiceItemId: local.items[0].id, pickedQty: 1, cellBlockId: cell, isFinal: false }), 201);
    const gone = await order(4); const goneSupply = await supplyOf([gone]);   // уехал, WB не принял → «В пути»
    await pickAll(goneSupply, 4);
    must(await api('POST', `/api/supplies/${goneSupply.id}/ship`, owner, {}));
    const accepted = await order(5); const acceptedSupply = await supplyOf([accepted]);   // уехал и принят WB → нигде
    await pickAll(acceptedSupply, 5);
    must(await api('POST', `/api/supplies/${acceptedSupply.id}/ship`, owner, {}));
    await run((c) => c.query(`UPDATE invoices SET mp_closed_at = now(), mp_close_reason = 'fulfilled' WHERE id = $1`, [accepted.id]));
    const canceled = await order(6);                        // отменён WB до работы → нигде
    await run((c) => c.query(`UPDATE invoices SET mp_closed_at = now(), mp_close_reason = 'canceled' WHERE id = $1`, [canceled.id]));
    const conflict = await order(7); const conflictSupply = await supplyOf([conflict]);   // отменён после отбора → «В сборке»
    await pickAll(conflictSupply, 3);
    await run((c) => c.query(`UPDATE invoices SET mp_closed_at = now(), mp_close_reason = 'canceled', supply_id = NULL WHERE id = $1`, [conflict.id]));
    const other = await order(2, { sku: 'P-2' });           // другой товар — не в списке P-1

    const stock = must(await api('GET', '/api/sellers/stock', seller)).rows.find((r) => r.sku === 'P-1');
    const list = must(await api('GET', '/api/sellers/orders?sku=P-1', seller));
    const sum = (bucket) => list.rows.filter((r) => r.bucket === bucket).reduce((s, r) => s + Number(r.qty), 0);
    const numbers = (bucket) => list.rows.filter((r) => r.bucket === bucket).map((r) => r.number).sort();
    check('список за «Заказано» даёт ровно число «Заказано»: заказ без поставки', () => {
      assert.equal(sum('ordered'), stock.ordered);
      assert.deepEqual(numbers('ordered'), [queued.number]);
    });
    check('«В сборке»: в поставке, отобранный без поставки и отменённый после отбора', () => {
      assert.equal(sum('assembly'), stock.inAssembly);
      assert.deepEqual(numbers('assembly'), [inSupply.number, local.number, conflict.number].sort());
    });
    check('«В пути»: уехал поставкой, WB ещё не принял; принятый и отменённый — ни под каким числом', () => {
      assert.equal(sum('transit'), stock.inTransit);
      assert.deepEqual(numbers('transit'), [gone.number]);
      assert.equal(list.rows.find((r) => r.number === accepted.number).bucket, null);
      assert.equal(list.rows.find((r) => r.number === canceled.number).bucket, null);
    });
    check('?sku= — только заказы этого товара; поставка у заказа указана', () => {
      assert.ok(list.rows.every((r) => r.sku === 'P-1'));
      assert.ok(!list.rows.some((r) => r.number === other.number));
      assert.ok(list.rows.find((r) => r.number === gone.number).supply_number);
    });
    const allRows = must(await api('GET', '/api/sellers/orders', seller)).rows;
    const bad = await api('GET', '/api/sellers/orders?sku=', seller);
    check('без ?sku= — все заказы, как раньше; пустой артикул — 400', () => {
      assert.ok(allRows.some((r) => r.number === other.number));
      assert.equal(bad.status, 400);
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
