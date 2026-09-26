// Данные нового кабинета продавца (владелец 26.09.2026): название
// фулфилмента, «В пути» (уехало на WB, WB ещё не принял), брак, приход с
// перевозчиком и тем, кто и когда принимал, возврат с годным и браком,
// поставка у заказа. Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Seller cabinet data E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
      name: 'Cabinet test', email: `cabinet-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Восход', city: 'Москва',
    }), 201).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Слим Тест' }), 201).id;
    await run((c) => c.query(`INSERT INTO products (warehouse_id, company_id, sku, name, barcode, stock_qty_1c, stock_at)
      VALUES ($1, $2, 'PB-1', 'Батончик', '4600000000011', 20, now())`, [warehouseId, company]));
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 3, tierCount: 1 }] }), 201);
    const cells = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const staff = must(await api('POST', '/api/staff', owner, { name: 'Грузчик Иван' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code })).token;
    const key = must(await api('POST', `/api/sellers/companies/${company}/keys`, owner, {}), 201);
    const seller = must(await api('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Продавец' })).token;

    const profile = must(await api('GET', '/api/sellers/profile', seller));
    check('в шапке — название фулфилмента', () => assert.equal(profile.warehouseName, 'Восход'));

    // Приход через «Привезти товар»: кто везёт, машина, комментарий.
    const inbound = must(await api('POST', '/api/sellers/inbound', seller, {
      grid: [['Штрихкод', 'Количество'], ['4600000000011', 12]], apply: true, plannedDate: '2026-09-30',
      carrier: '  ТК «Байкал»  ', vehicle: 'А123ВС 77', comment: 'Два короба',
    })).invoice;
    const doc = must(await api('GET', `/api/invoices/${inbound.id}`, owner));
    must(await api('POST', '/api/receiving', worker, { invoiceItemId: doc.items[0].id, acceptedQty: 11, cellBlockId: cells[0].id }), 201);
    // Возврат: 2 годных, 1 брак с описанием.
    const ret = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'ВЗ-1', direction: 'return',
      items: [{ sku: 'PB-1', name: 'Батончик', declaredQty: 3 }] }), 201);
    must(await api('POST', '/api/returns', worker, { invoiceItemId: ret.items[0].id, qty: 2, qualityBucket: 'good', cellBlockId: cells[1].id }), 201);
    must(await api('POST', '/api/returns', worker, { invoiceItemId: ret.items[0].id, qty: 1, qualityBucket: 'defective', cellBlockId: cells[2].id, defectNote: 'Раздавлена упаковка' }), 201);

    const docs = must(await api('GET', '/api/sellers/documents', seller)).rows;
    const inRow = docs.find((r) => r.id === inbound.id);
    const retRow = docs.find((r) => r.id === ret.id);
    check('приход: кто вёз, машина, комментарий, когда начали выгрузку, сколько принято и кто принимал', () => {
      assert.equal(inRow.carrier, 'ТК «Байкал»');
      assert.equal(inRow.vehicle, 'А123ВС 77');
      assert.equal(inRow.inbound_comment, 'Два короба');
      assert.ok(inRow.first_at);
      assert.equal(Number(inRow.done_qty), 11);
      assert.equal(Number(inRow.declared_qty), 12);
      assert.deepEqual(inRow.received_by, ['Грузчик Иван']);
    });
    check('возврат: годное и брак отдельно', () => {
      assert.equal(Number(retRow.good_qty), 2);
      assert.equal(Number(retRow.bad_qty), 1);
    });

    const defects = must(await api('GET', '/api/sellers/defects', seller));
    check('брак: сколько лежит сейчас и откуда он с описанием', () => {
      assert.deepEqual(defects.now.map((r) => [r.sku, r.defective]), [['PB-1', 1]]);
      assert.equal(defects.events[0].note, 'Раздавлена упаковка');
      assert.equal(defects.events[0].source, 'Возврат');
      assert.equal(defects.events[0].document, 'ВЗ-1');
    });

    // Заказ уехал поставкой — «в пути», пока WB его не принял.
    const order = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'WB-1', direction: 'out',
      items: [{ sku: 'PB-1', name: 'Батончик', declaredQty: 2 }] }), 201);
    await run((c) => c.query(`UPDATE invoices SET source = 'wb', external_id = '1' WHERE id = $1`, [order.id]));
    await run((c) => c.query(`UPDATE invoice_items SET mp_rid = 'rid-1' WHERE invoice_id = $1`, [order.id]));
    const supply = must(await api('POST', '/api/supplies', owner, { invoiceIds: [order.id], marketplace: 'wb', destination: 'СЦ Коледино' }), 201);
    must(await api('POST', '/api/shipping', worker, { invoiceItemId: order.items[0].id, pickedQty: 2, cellBlockId: cells[0].id }), 201);
    must(await api('POST', `/api/supplies/${supply.id}/ship`, owner, {}));
    const stock = must(await api('GET', '/api/sellers/stock', seller));
    const orders = must(await api('GET', '/api/sellers/orders', seller)).rows;
    check('«в пути» — уехавшее на WB; у заказа видна его поставка', () => {
      assert.equal(stock.rows[0].inTransit, 2);
      assert.equal(stock.summary.inTransit, 2);
      assert.equal(stock.rows[0].defective, 1);
      const o = orders.find((r) => r.id === order.id);
      assert.equal(o.supply_number, supply.number);
      assert.equal(o.supply_destination, 'СЦ Коледино');
    });
    await run((c) => c.query(`UPDATE invoices SET mp_status = 'sorted', mp_closed_at = now(), mp_close_reason = 'fulfilled' WHERE id = $1`, [order.id]));
    const accepted = must(await api('GET', '/api/sellers/stock', seller));
    const asOwner = must(await api('GET', `/api/sellers/stock?companyId=${company}&view=seller`, owner));
    check('WB принял — из «в пути» ушло; владелец видит кабинет глазами продавца', () => {
      assert.equal(accepted.summary.inTransit, 0);
      assert.ok(Array.isArray(asOwner.rows) && asOwner.summary);
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
