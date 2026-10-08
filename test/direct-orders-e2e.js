// Заказы физлицам по полной схеме (владелец 08.10.2026): заказ заводит склад
// или продавец, он стоит в «Заказах», склад составляет из таких заказов
// поставку (несколько физлиц в одной), после отъезда — трек и статусы.
// Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Direct orders E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
    const owner = must(await api('POST', '/api/auth/owner/register', null, { name: 'Физлица', email: `dorders-${stamp}@test.local`,
      password: 'test-password-only', warehouseName: 'Физлица', city: 'Test' }), 201).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    must(await api('PATCH', '/api/warehouses/me', owner, { stockSource: 'argus' }));
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Продавец' }), 201).id;
    const other = must(await api('POST', '/api/sellers/companies', owner, { name: 'Чужой' }), 201).id;
    must(await api('POST', '/api/products', owner, { sku: 'F-1', name: 'Корсет', companyId: company, barcode: '4600000000011' }), 201);
    must(await api('POST', '/api/products', owner, { sku: 'F-2', name: 'Пояс', companyId: company, barcode: '4600000000028' }), 201);
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 2, tierCount: 1 }] }), 201);
    const cell = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks)[0].id;
    await run((c) => c.query(`INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty)
      VALUES ($1,$2,$3,'F-1',10), ($1,$2,$3,'F-2',5)`, [cell, warehouseId, company]));
    const key = must(await api('POST', '/api/staff', owner, { name: 'Грузчик' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
    const login = async (id) => must(await api('POST', '/api/auth/seller/login', null, {
      keyCode: must(await api('POST', `/api/sellers/companies/${id}/keys`, owner, {}), 201).key_code, name: 'Продавец' })).token;
    const seller = await login(company);
    const stranger = await login(other);
    const to = { recipient: 'Иванов Иван', address: 'Казань, ул. Баумана, 1', phone: '+7 900 000-00-00', deliveryService: 'СДЭК' };
    const stockOf = async () => Object.fromEntries(must(await api('GET', '/api/sellers/stock', seller)).rows.map((r) => [r.sku, r]));

    // Склад заводит заказ.
    const noTo = await api('POST', '/api/direct-orders', owner, { companyId: company, items: [{ sku: 'F-1', qty: 1 }], address: 'Казань' });
    const wrongSku = await api('POST', '/api/direct-orders', owner, { companyId: company, ...to, items: [{ sku: 'X', qty: 1 }] });
    check('без получателя или с чужим товаром — не создаётся', () => {
      assert.equal(noTo.status, 400); assert.equal(wrongSku.status, 400);
    });
    const a = must(await api('POST', '/api/direct-orders', owner, { companyId: company, ...to,
      items: [{ sku: 'F-1', qty: 2 }], comment: 'Позвонить за час' }), 201);
    const pending = must(await api('GET', `/api/supplies/pending/${company}`, owner)).filter((o) => o.id === a.id);
    const stock1 = await stockOf();
    check('заказ склада — в «Заказах» с получателем, готов к поставке; у продавца «Заказано»', () => {
      assert.match(a.number, /^ЗФ-\d{6}-1$/);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].marketplace, 'direct');
      assert.equal(pending[0].ready, true);
      assert.equal(pending[0].direct.recipient, 'Иванов Иван');
      assert.equal(pending[0].direct.fromSeller, false);
      assert.equal(stock1['F-1'].ordered, 2);
      assert.equal(stock1['F-1'].available, 8);
    });
    const workerDocs = must(await api('GET', '/api/invoices?direction=out', worker));
    check('грузчик заказ вне поставки не видит', () => assert.ok(!workerDocs.some((d) => d.id === a.id)));

    // Продавец заводит сам — не больше свободного.
    const over = await api('POST', '/api/direct-orders', seller, { ...to, items: [{ sku: 'F-1', qty: 9 }] });
    const requestId = require('crypto').randomUUID();
    const body = { ...to, recipient: 'Петров', items: [{ sku: 'F-1', qty: 3 }], requestId, companyId: other };
    const twin = await Promise.all([api('POST', '/api/direct-orders', seller, body), api('POST', '/api/direct-orders', seller, body)]);
    const b = twin.find((r) => r.status === 201).body;
    const bRow = (await run((c) => c.query('SELECT company_id FROM invoices WHERE id = $1', [b.id]))).rows[0];
    check('продавец: больше свободного — отказ; повтор окна — тот же заказ; чужой companyId не действует', () => {
      assert.equal(over.status, 409); assert.match(over.body.error, /свободно 8/);
      assert.deepEqual(twin.map((r) => r.status).sort(), [200, 201]);
      assert.equal(twin[0].body.number, twin[1].body.number);
      assert.equal(bRow.company_id, company);
    });
    const strangerSees = must(await api('GET', '/api/direct-orders', stranger)).rows;
    const strangerPatch = await api('PATCH', `/api/direct-orders/${a.id}`, stranger, { trackNumber: '123' });
    const strangerCancel = await api('DELETE', `/api/direct-orders/${a.id}`, stranger);
    const sellerOrders = must(await api('GET', '/api/sellers/orders', seller)).rows.filter((r) => r.id === b.id);
    check('чужой продавец заказов не видит и не трогает; свой видит получателя и статус', () => {
      assert.equal(strangerSees.length, 0);
      assert.equal(strangerPatch.status, 404); assert.equal(strangerCancel.status, 404);
      assert.equal(sellerOrders[0].source, 'direct');
      assert.equal(sellerOrders[0].recipient, 'Петров');
      assert.equal(sellerOrders[0].direct_status, 'new');
    });
    must(await api('PATCH', '/api/warehouses/me', owner, { sellersDirectOrders: false }));
    const off = await api('POST', '/api/direct-orders', seller, { ...to, items: [{ sku: 'F-2', qty: 1 }] });
    const profileOff = must(await api('GET', '/api/sellers/profile', seller));
    must(await api('PATCH', '/api/warehouses/me', owner, { sellersDirectOrders: true }));
    check('склад выключил заказы от продавцов — продавцу отказ и кнопки нет', () => {
      assert.equal(off.status, 403); assert.equal(profileOff.directOrders, false);
    });

    // Трек — когда угодно, статус после отъезда — только после отъезда.
    const early = await api('PATCH', `/api/direct-orders/${a.id}`, owner, { deliveryStatus: 'in_transit' });
    must(await api('PATCH', `/api/direct-orders/${a.id}`, seller, { trackNumber: '10012345678' }));
    check('до отъезда статус «в пути» не ставится, трек-номер — да', () => assert.equal(early.status, 409));

    // Поставка из двух заказов физлицам; с накладной 1С — не смешивается.
    const onec = (await run(async (c) => {
      const i = (await c.query(`INSERT INTO invoices (warehouse_id, company_id, number, direction, source) VALUES ($1,$2,'1C-1','out','1c') RETURNING id`,
        [warehouseId, company])).rows[0];
      await c.query(`INSERT INTO invoice_items (invoice_id, warehouse_id, company_id, name, sku, declared_qty) VALUES ($1,$2,$3,'Пояс','F-2',1)`,
        [i.id, warehouseId, company]);
      return i;
    }));
    const mixed = await api('POST', '/api/supplies', owner, { invoiceIds: [a.id, onec.id], marketplace: 'wb' });
    const supply = must(await api('POST', '/api/supplies', owner, { invoiceIds: [a.id, b.id], marketplace: 'wb' }), 201);
    const listed = must(await api('GET', '/api/supplies', owner)).find((s) => s.id === supply.id);
    check('заказы физлицам — своей поставкой: не на WB, точка — «физлицам»; с 1С не смешать', () => {
      assert.equal(mixed.status, 400);
      assert.equal(listed.marketplace, null);
      assert.equal(listed.destination, 'Физлицам: 2 заказа');
    });
    const cancelInSupply = await api('DELETE', `/api/direct-orders/${a.id}`, seller);
    check('заказ в поставке продавец не отменяет', () => assert.equal(cancelInSupply.status, 409));

    // Сборка, отъезд, статусы.
    must(await api('POST', `/api/shipping/assembly/${supply.id}/start`, worker, {}), 201);
    for (const id of [a.id, b.id]) {
      for (const it of must(await api('GET', `/api/invoices/${id}`, owner)).items) {
        must(await api('POST', '/api/shipping', worker, { invoiceItemId: it.id, pickedQty: Number(it.declared_qty), cellBlockId: cell }), 201);
      }
    }
    const ready = must(await api('GET', '/api/direct-orders', owner)).rows.find((r) => r.id === a.id);
    must(await api('POST', `/api/supplies/${supply.id}/ship`, worker, {}));
    const shipped = must(await api('GET', '/api/direct-orders', owner)).rows.find((r) => r.id === a.id);
    const stock2 = await stockOf();
    check('собран → уехал; уехавшее не висит «В пути» и ушло из «Всего»', () => {
      assert.equal(ready.status, 'ready');
      assert.equal(shipped.status, 'shipped'); assert.equal(shipped.statusName, 'Уехал');
      assert.equal(shipped.trackNumber, '10012345678');
      assert.equal(stock2['F-1'].inTransit, 0);
      assert.equal(stock2['F-1'].total, 5);
      assert.equal(stock2['F-1'].available, 5);
    });
    const bad = await api('PATCH', `/api/direct-orders/${a.id}`, owner, { deliveryStatus: 'lost' });
    must(await api('PATCH', `/api/direct-orders/${a.id}`, owner, { deliveryStatus: 'in_transit' }));
    const done = must(await api('PATCH', `/api/direct-orders/${a.id}`, seller, { deliveryStatus: 'delivered' }));
    check('после отъезда: «в пути», «доставлен» — склад и продавец; чужого статуса нет', () => {
      assert.equal(bad.status, 400);
      assert.equal(done.status, 'delivered'); assert.equal(done.statusName, 'Доставлен');
    });

    // Отмена нового и разбор поставки.
    const c1 = must(await api('POST', '/api/direct-orders', seller, { ...to, items: [{ sku: 'F-2', qty: 1 }] }), 201);
    must(await api('DELETE', `/api/direct-orders/${c1.id}`, seller));
    const gone = (await run((c) => c.query('SELECT 1 FROM invoices WHERE id = $1', [c1.id]))).rows.length;
    const d1 = must(await api('POST', '/api/direct-orders', owner, { companyId: company, ...to, items: [{ sku: 'F-2', qty: 2 }], toSupply: true }), 201);
    must(await api('DELETE', `/api/supplies/${d1.supply.id}`, owner));
    const back = must(await api('GET', `/api/supplies/pending/${company}`, owner)).some((o) => o.id === d1.id);
    check('новый заказ отменяется; «сразу на сборку» — поставка; разобрали — заказ вернулся в очередь', () => {
      assert.equal(gone, 0);
      assert.match(d1.supply.number, /^ПС-/);
      assert.equal(back, true);
    });

    // Склад продавца: свободно — на этом складе, поставка — с него же.
    const vw = must(await api('POST', '/api/vwarehouses', owner, { companyId: company, name: 'Озон', marketplace: 'ozon' }), 201);
    await run((c) => c.query(`INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, virtual_warehouse_id)
      VALUES ($1,$2,$3,'F-2',3,$4)`, [cell, warehouseId, company, vw.id]));
    const vwOver = await api('POST', '/api/direct-orders', seller, { ...to, vwId: vw.id, items: [{ sku: 'F-2', qty: 4 }] });
    const e1 = must(await api('POST', '/api/direct-orders', seller, { ...to, vwId: vw.id, items: [{ sku: 'F-2', qty: 3 }] }), 201);
    const vwAfter = await api('POST', '/api/direct-orders', seller, { ...to, vwId: vw.id, items: [{ sku: 'F-2', qty: 1 }] });
    const twoVws = await api('POST', '/api/supplies', owner, { invoiceIds: [d1.id, e1.id] });
    const fromVw = must(await api('POST', '/api/supplies', owner, { invoiceIds: [e1.id] }), 201);
    check('со своего склада продавца — не больше его свободного; поставка — с того же склада', () => {
      assert.equal(vwOver.status, 409, JSON.stringify(vwOver.body));
      assert.equal(vwAfter.status, 409, 'второй заказ на тот же товар склада прошёл');
      assert.equal(fromVw.virtualWarehouseId, vw.id);
      assert.equal(twoVws.status, 400);
    });
  } catch (e) {
    failed += 1; console.log('FAIL тест упал: ' + e.stack);
  } finally {
    server.close(); await pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})();
