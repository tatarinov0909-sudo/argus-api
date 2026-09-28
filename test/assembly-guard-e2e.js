// Защита сборки поставки (владелец 29.09.2026: «защита точно нужна» — как у
// приёмки): взять товар, отметить «нет товара», собрать по товару и «собрал
// по листу» — только тот, кто ведёт сборку, и не на паузе («Собрал по
// листу» можно и с паузы). Заказы без поставки захода не имеют — как было.
// Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Assembly guard E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
      name: 'Guard test', email: `guard-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Guard test', city: 'Test',
    }), 201).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Защита' }), 201).id;
    for (const [sku, name] of [['G-1', 'Батончик'], ['G-2', 'Паста']]) {
      must(await api('POST', '/api/products', owner, { sku, name, companyId: company }), 201);
    }
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 3, tierCount: 1 }] }), 201);
    const cells = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const login = async (name) => {
      const key = must(await api('POST', '/api/staff', owner, { name }), 201);
      return must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
    };
    const dima = await login('Дима');
    const ivan = await login('Иван');

    const receipt = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'IN-G',
      items: [{ sku: 'G-1', name: 'Батончик', declaredQty: 10 }, { sku: 'G-2', name: 'Паста', declaredQty: 10 }] }), 201);
    must(await api('POST', `/api/receiving/session/${receipt.id}/start`, dima, {}), 201);
    must(await api('POST', '/api/receiving', dima, { invoiceItemId: receipt.items[0].id, acceptedQty: 10, cellBlockId: cells[0].id }), 201);
    must(await api('POST', '/api/receiving', dima, { invoiceItemId: receipt.items[1].id, acceptedQty: 10, cellBlockId: cells[1].id }), 201);

    const order = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'WB-G1', direction: 'out',
      items: [{ sku: 'G-1', name: 'Батончик', declaredQty: 3 }, { sku: 'G-2', name: 'Паста', declaredQty: 2 }] }), 201);
    await run((c) => c.query(`UPDATE invoices SET source = 'wb', external_id = 'WB-G1' WHERE id = $1`, [order.id]));
    await run((c) => c.query(`UPDATE invoice_items SET mp_rid = 'rid-' || id WHERE invoice_id = $1`, [order.id]));
    const supply = must(await api('POST', '/api/supplies', owner, { invoiceIds: [order.id], marketplace: 'wb' }), 201);
    const bar = order.items.find((i) => i.sku === 'G-1').id;
    const paste = order.items.find((i) => i.sku === 'G-2').id;
    const pick = (token, qty = 1) => api('POST', '/api/shipping', token, { invoiceItemId: bar, pickedQty: qty, cellBlockId: cells[0].id, isFinal: false });
    const byProduct = (token) => api('POST', '/api/shipping/product', token, { supplyId: supply.id, sku: 'G-2', cellBlockId: cells[1].id, pickedQty: 1 });
    const missing = (token) => api('POST', '/api/shipping/missing', token, { invoiceItemId: paste, missingQty: 1 });

    // Никто не начинал.
    const [p0, g0, m0] = [await pick(dima), await byProduct(dima), await missing(dima)];
    const paper0 = await api('POST', '/api/shipping/paper/finish', dima, { supplyId: supply.id, notFound: [] });
    check('без «Начать»: взять, собрать по товару, «нет товара», «собрал по листу» — отказ', () => {
      for (const r of [p0, g0, m0, paper0]) assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(p0.body.error, /не начата — нажмите «Начать сборку»/);
      assert.match(paper0.body.error, /не начата/);
    });

    // Сборку ведёт Дима — Иван не берёт за него.
    must(await api('POST', `/api/shipping/assembly/${supply.id}/start`, dima, {}), 201);
    const [p1, g1, m1] = [await pick(ivan), await byProduct(ivan), await missing(ivan)];
    const paper1 = await api('POST', '/api/shipping/paper/finish', ivan, { supplyId: supply.id, notFound: [] });
    check('чужую сборку не собрать: «Поставку собирает Дима… Забрать сборку себе?»', () => {
      for (const r of [p1, g1, m1, paper1]) assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(p1.body.error, /собирает Дима/);
    });

    // Дима берёт — можно.
    const p2 = await pick(dima);
    check('свою идущую сборку собирать можно', () => assert.equal(p2.status, 201, JSON.stringify(p2.body)));

    // Пауза — заперто.
    must(await api('POST', '/api/journal/pause', dima, { supplyId: supply.id, reason: 'обед' }), 201);
    const [p3, g3, m3] = [await pick(dima), await byProduct(dima), await missing(dima)];
    check('на паузе: взять, собрать по товару, «нет товара» — отказ «сначала «Продолжить»»', () => {
      for (const r of [p3, g3, m3]) assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(p3.body.error, /на паузе — сначала «Продолжить»/);
    });
    const taken = (await run((c) => c.query(
      'SELECT COALESCE(SUM(picked_qty), 0)::int AS n FROM shipping_records WHERE invoice_item_id IN ($1, $2)', [bar, paste]))).rows[0].n;
    check('в базе — только то, что взял Дима до паузы: 1 шт.', () => assert.equal(taken, 1));

    // «Собрал по листу» — можно и с паузы: это конец своей сборки.
    const paper = await api('POST', '/api/shipping/paper/finish', dima, { supplyId: supply.id, notFound: [] });
    check('«Собрал по листу» со своей паузы — можно', () => assert.equal(paper.status, 201, JSON.stringify(paper.body)));

    // Заказ без поставки (отгрузка 1С) — захода нет, собирают как раньше.
    const loose = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'РЛ-G1', direction: 'out',
      items: [{ sku: 'G-2', name: 'Паста', declaredQty: 1 }] }), 201);
    const looseOk = await api('POST', '/api/shipping', ivan, { invoiceItemId: loose.items[0].id, pickedQty: 1, cellBlockId: cells[1].id });
    check('заказ без поставки — собирается без захода, как раньше', () => assert.equal(looseOk.status, 201, JSON.stringify(looseOk.body)));

    console.log(`\n${passed} checks passed`);
  } finally {
    server.close();
    await require('../src/db/pool').pool.end();
  }
})().catch((err) => { console.error('FAIL', err); process.exitCode = 1; });
