// Сборка по бумажному листу: грузчик сканирует QR листа (начало и таймер),
// собирает по бумаге и отмечает с телефона «собрал по листу» и чего не нашёл.
// Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Paper pick E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
    const reg = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Paper test', email: `paper-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Paper test', city: 'Test',
    }), 201);
    const owner = reg.token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Слим Тест' }), 201).id;
    for (const [sku, name] of [['PB-1', 'Батончик'], ['PB-2', 'Паста'], ['PB-3', 'Хлебцы']]) {
      must(await api('POST', '/api/products', owner, { sku, name, companyId: company }), 201);
    }
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 3, tierCount: 1 }] }), 201);
    const cells = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const staff = must(await api('POST', '/api/staff', owner, { name: 'Грузчик Иван' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code })).token;

    // На полках: батончик 2 + 2 в двух ячейках, паста 5. Хлебцов в ячейках нет.
    const receipt = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'IN-1',
      items: [{ sku: 'PB-1', name: 'Батончик', declaredQty: 2 }, { sku: 'PB-1', name: 'Батончик', declaredQty: 2 },
        { sku: 'PB-2', name: 'Паста', declaredQty: 5 }] }), 201);
    must(await api('POST', '/api/receiving', worker, { invoiceItemId: receipt.items[0].id, acceptedQty: 2, cellBlockId: cells[0].id }), 201);
    must(await api('POST', '/api/receiving', worker, { invoiceItemId: receipt.items[1].id, acceptedQty: 2, cellBlockId: cells[1].id }), 201);
    must(await api('POST', '/api/receiving', worker, { invoiceItemId: receipt.items[2].id, acceptedQty: 5, cellBlockId: cells[2].id }), 201);

    // Два заказа WB в одной поставке: батончик 3 (2 + 1), паста 2, хлебцы 1.
    const orders = [];
    for (const [n, items] of [['WB-1', [['PB-1', 'Батончик', 2], ['PB-2', 'Паста', 2]]], ['WB-2', [['PB-1', 'Батончик', 1], ['PB-3', 'Хлебцы', 1]]]]) {
      const o = must(await api('POST', '/api/invoices', owner, { companyId: company, number: n, direction: 'out',
        items: items.map(([sku, name, declaredQty]) => ({ sku, name, declaredQty })) }), 201);
      await run((c) => c.query(`UPDATE invoices SET source = 'wb', external_id = $2 WHERE id = $1`, [o.id, n]));
      await run((c) => c.query(`UPDATE invoice_items SET mp_rid = 'rid-' || id WHERE invoice_id = $1`, [o.id]));
      orders.push(o);
    }
    const supply = must(await api('POST', '/api/supplies', owner, { invoiceIds: orders.map((o) => o.id), marketplace: 'wb' }), 201);

    const started = must(await api('POST', '/api/shipping/paper/start', worker, { supplyId: supply.id }), 201);
    const byOwner = await api('POST', '/api/shipping/paper/start', owner, { supplyId: supply.id });
    check('скан листа: начало записано в журнал, время начала — от сервера; руководитель так не может', () => {
      assert.equal(started.number, supply.number);
      assert.ok(!Number.isNaN(new Date(started.startedAt).getTime()));
      assert.equal(byOwner.status, 403);
    });

    // Пасту не нашёл вовсе; хлебцы «нашёл», но в ячейках Аргуса их нет.
    const startedAt = new Date(Date.now() - 12 * 60000).toISOString();
    const done = must(await api('POST', '/api/shipping/paper/finish', worker, {
      supplyId: supply.id, startedAt, pausedMs: 0, notFound: [{ sku: 'PB-2', found: 0 }],
    }), 201);
    const bySku = Object.fromEntries(done.report.map((r) => [r.sku, r]));
    check('найденное записано отбором из ячеек по обходу, ненайденное — отметкой', () => {
      assert.equal(bySku['PB-1'].taken, 3);
      assert.equal(bySku['PB-2'].taken, 0); assert.equal(bySku['PB-2'].missing, 2);
      assert.equal(bySku['PB-3'].taken, 0); assert.equal(bySku['PB-3'].noCells, true);
      assert.equal(done.minutes, 12);
    });
    const stock = await run((c) => c.query(
      `SELECT sku, SUM(qty)::int AS q FROM cell_stock WHERE warehouse_id = $1 GROUP BY sku ORDER BY sku`, [warehouseId],
    ));
    check('с полок снято ровно взятое: батончик 4 → 1, паста не тронута', () => {
      assert.deepEqual(stock.rows, [{ sku: 'PB-1', q: 1 }, { sku: 'PB-2', q: 5 }]);
    });
    const urgent = await run((c) => c.query(
      `SELECT action_text FROM journal_entries WHERE warehouse_id = $1 AND urgent AND status = 'pending' ORDER BY action_text`,
      [warehouseId],
    ));
    const journal = must(await api('GET', '/api/journal', owner)).map((e) => e.action_text).join('\n');
    check('руководителю: «нет товара» по пасте и хлебцам, итог по листу с временем', () => {
      assert.equal(urgent.rows.length, 2);
      assert.ok(urgent.rows.every((r) => /по бумажному листу/.test(r.action_text)));
      assert.ok(urgent.rows.some((r) => /Хлебцы.*в ячейках Аргуса его нет/.test(r.action_text)));
      assert.match(journal, /начал сборку поставки «ПС-\d{6}-\d{2}» по бумажному листу/);
      assert.match(journal, /собрал поставку «ПС-\d{6}-\d{2}» по бумажному листу за 12 мин: взято 3 шт\. Не нашёл: «Паста» — 2 шт\./);
    });

    const again = await api('POST', '/api/shipping/paper/finish', worker, { supplyId: supply.id, notFound: [] });
    const badMark = await api('POST', '/api/shipping/paper/finish', worker, { supplyId: supply.id, notFound: [{ sku: 'PB-2', found: -1 }] });
    check('второй «собрал по листу» — нечего собирать; кривая отметка — 400', () => {
      assert.equal(again.status, 409);
      assert.equal(badMark.status, 400);
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
