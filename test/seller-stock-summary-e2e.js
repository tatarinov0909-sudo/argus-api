// «Остатки продавцов» в кабинете владельца (владелец 02.10.2026): сводка по
// всем продавцам — те же числа, что продавец видит у себя, — и умение
// Кладовщика «остатки продавцов» тем же правилом. Только на отдельной
// тестовой базе.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const kladovshchik = require('../src/agents/kladovshchik');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, token, body, status = 200) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    assert.equal(res.status, status, `${method} ${path}: ${res.status} ${data && data.error || ''}`);
    return data;
  };
  let passed = 0;
  const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
  try {
    const owner = (await api('POST', '/api/auth/owner/register', null, {
      name: 'Сводка', email: `stock-sum-${Date.now()}@example.test`, password: 'test-only-password', warehouseName: 'Сводка', city: 'Test',
    }, 201)).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const db = (sql, args) => run((c) => c.query(sql, args));
    await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 4, tierCount: 1 }] }, 201);
    const cells = (await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const wk = await api('POST', '/api/staff', owner, { name: 'Грузчик' }, 201);
    const worker = (await api('POST', '/api/auth/staff/login', null, { keyCode: wk.key_code })).token;

    const seller = async (name, products) => {
      const id = (await api('POST', '/api/sellers/companies', owner, { name }, 201)).id;
      for (const [sku, title] of products) await api('POST', '/api/products', owner, { sku, name: title, companyId: id }, 201);
      const key = await api('POST', `/api/sellers/companies/${id}/keys`, owner, {}, 201);
      const token = (await api('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Продавец' })).token;
      return { id, token };
    };
    const slim = await seller('Слим Сводка', [['SS-1', 'Батончик'], ['SS-2', 'Паста'], ['SS-3', 'Без учёта']]);
    const avez = await seller('Авезов Сводка', [['AS-1', 'Гранола']]);

    // Приняли в ячейки, учёт 1С: батончик 20, паста 2, гранола 7.
    const receipt = await api('POST', '/api/invoices', owner, { companyId: slim.id, number: 'SS-IN',
      items: [{ sku: 'SS-1', name: 'Батончик', declaredQty: 10 }, { sku: 'SS-2', name: 'Паста', declaredQty: 2 }] }, 201);
    await api('POST', `/api/receiving/session/${receipt.id}/start`, worker, {}, 201);
    await api('POST', '/api/receiving', worker, { invoiceItemId: receipt.items[0].id, acceptedQty: 10, cellBlockId: cells[0].id }, 201);
    await api('POST', '/api/receiving', worker, { invoiceItemId: receipt.items[1].id, acceptedQty: 2, cellBlockId: cells[1].id }, 201);
    await db("UPDATE products SET stock_qty_1c = 20, stock_at = now() WHERE company_id = $1 AND sku = 'SS-1'", [slim.id]);
    await db("UPDATE products SET stock_qty_1c = 2, stock_at = now() WHERE company_id = $1 AND sku = 'SS-2'", [slim.id]);
    await db("UPDATE products SET stock_qty_1c = 7, stock_at = now() WHERE company_id = $1 AND sku = 'AS-1'", [avez.id]);
    // Заказы: батончик 3, пасты 5 — пасты на складе 2, заказов больше.
    for (const [number, sku, name, qty] of [['WB-SS1', 'SS-1', 'Батончик', 3], ['WB-SS2', 'SS-2', 'Паста', 5]]) {
      const o = await api('POST', '/api/invoices', owner, { companyId: slim.id, number, direction: 'out',
        items: [{ sku, name, declaredQty: qty }] }, 201);
      await db("UPDATE invoices SET source = 'wb', external_id = $2 WHERE id = $1", [o.id, number]);
    }
    // Брак батончика — 1 шт. на складе брака.
    const ret = await api('POST', '/api/returns/manual', worker, { companyId: slim.id, items: [{ sku: 'SS-1', qty: 1 }] }, 201);
    const retItem = (await api('GET', `/api/invoices/${ret.id}`, worker)).items[0];
    await api('POST', '/api/returns', worker, { invoiceItemId: retItem.id, qty: 1, qualityBucket: 'defective', cellBlockId: cells[3].id }, 201);

    // ---- Сводка владельца = итог в кабинете продавца ----
    const sum = await api('GET', '/api/sellers/stock-summary', owner);
    assert.deepEqual(sum.sellers.map((s) => s.name), ['Авезов Сводка', 'Слим Сводка']);
    const own = (await api('GET', '/api/sellers/stock', slim.token)).summary;
    const row = sum.sellers.find((s) => s.companyId === slim.id);
    for (const f of ['productCount', 'total', 'ordered', 'inAssembly', 'inTransit', 'available', 'defect', 'shortageCount', 'unknownCount']) {
      assert.equal(row[f], own[f], `${f}: владелец ${row[f]}, продавец ${own[f]}`);
    }
    assert.deepEqual([row.total, row.ordered, row.available, row.defect, row.shortageCount, row.unknownCount, row.inCells], [22, 8, 17, 1, 1, 1, 13]);
    check('сводка владельца: у каждого продавца те же числа, что он видит у себя, и сколько в ячейках');

    await api('GET', '/api/sellers/stock-summary', worker, undefined, 403);
    await api('GET', '/api/sellers/stock-summary', slim.token, undefined, 403);
    const mk = await api('POST', '/api/staff', owner, { name: 'Менеджер', kind: 'manager' }, 201);
    const manager = (await api('POST', '/api/auth/staff/login', null, { keyCode: mk.key_code })).token;
    await api('GET', '/api/sellers/stock-summary', manager, undefined, 200);
    check('сводку видят владелец и менеджер; грузчик и продавец — нет');

    // ---- Кладовщик: остатки продавцов ----
    const tool = (args) => run((c) => kladovshchik.runTool(c, warehouseId, 'seller_stock', args));
    const all = await tool({});
    assert.deepEqual(all.sellers.map((s) => [s.seller, s.total, s.available, s.shortageProducts]),
      [['Авезов Сводка', 7, 7, 0], ['Слим Сводка', 22, 17, 1]]);
    const one = await tool({ seller: 'слим' });
    assert.equal(one.seller, 'Слим Сводка');
    assert.deepEqual(one.shortages, [{ sku: 'SS-2', name: 'Паста', total: 2, ordered: 5, inAssembly: 0 }]);
    assert.deepEqual(one.defectProducts, [{ sku: 'SS-1', name: 'Батончик', defect: 1 }]);
    assert.deepEqual(await tool({ seller: 'сводка' }), { notFound: false, choose: ['Авезов Сводка', 'Слим Сводка'] });
    assert.equal((await tool({ seller: 'нет такого' })).notFound, true);
    check('Кладовщик: остатки продавцов теми же числами; по имени — чего не хватает и брак; неоднозначно — переспросить');

    console.log(`\n${passed} checks passed`);
  } finally {
    await new Promise((r) => server.close(r)); await pool.end();
  }
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
