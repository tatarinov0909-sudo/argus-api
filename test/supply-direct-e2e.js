// Поставка физлицу из товаров продавца (владелец 06.10.2026): «Поставки» →
// «Новая поставка» → товары → «Куда / кому». Одним шагом заказ и поставка;
// сборка обычная, «Уехала» без QR WB; уехавшее не висит «В пути».
// Плюс сопоставление строк Excel с каталогом для панели выбора товаров.
// Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Supply direct E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
    const owner = must(await api('POST', '/api/auth/owner/register', null, { name: 'Физлицу', email: `direct-${stamp}@test.local`,
      password: 'test-password-only', warehouseName: 'Физлицу', city: 'Test' }), 201).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Продавец' }), 201).id;
    const other = must(await api('POST', '/api/sellers/companies', owner, { name: 'Чужой' }), 201).id;
    must(await api('POST', '/api/products', owner, { sku: 'DR-1', name: 'Корсет', companyId: company, barcode: '0460000000011' }), 201);
    must(await api('POST', '/api/products', owner, { sku: 'DR-2', name: 'Пояс', companyId: company, barcode: '4600000000022' }), 201);
    must(await api('POST', '/api/products', owner, { sku: 'DR-3', name: 'Пояс двойник', companyId: company, barcode: '4600000000022' }), 201);
    must(await api('POST', '/api/products', owner, { sku: 'X-1', name: 'Чужой товар', companyId: other, barcode: '4600000000099' }), 201);
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 2, tierCount: 1 }] }), 201);
    const cell = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks)[0].id;
    await run((c) => c.query(`INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty)
      VALUES ($1,$2,$3,'DR-1',10), ($1,$2,$3,'DR-2',5)`, [cell, warehouseId, company]));
    // Учёт в 1С совпадает с ячейками — сверка была (как у продавцов «Восхода»).
    await run((c) => c.query(`UPDATE products SET stock_qty_1c = CASE sku WHEN 'DR-1' THEN 10 ELSE 5 END, stock_at = now()
      WHERE company_id = $1 AND sku IN ('DR-1', 'DR-2')`, [company]));
    await run((c) => c.query(`INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, details)
      VALUES ($1, $2, 'document_align', 'DR-1', 1, '{}')`, [warehouseId, company]));
    const key = must(await api('POST', '/api/staff', owner, { name: 'Грузчик' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
    const sellerKey = must(await api('POST', `/api/sellers/companies/${company}/keys`, owner, {}), 201);
    const seller = must(await api('POST', '/api/auth/seller/login', null, { keyCode: sellerKey.key_code, name: 'Продавец' })).token;

    // Сопоставление строк Excel с каталогом.
    const match = must(await api('POST', '/api/products/match', owner, { companyId: company, lines: [
      { sku: 'dr-1' }, { barcode: '0460000000011' }, { barcode: '4600000000022' }, { sku: 'DR-2', barcode: '0460000000011' },
      { sku: 'НЕТ' }, {}, { barcode: '4600000000099' },
    ] })).items;
    check('строки Excel узнаются по артикулу и штрихкоду, без угадывания', () => {
      assert.deepEqual(match.slice(0, 2).map((x) => x.sku), ['DR-1', 'DR-1']);
      assert.match(match[2].error, /нескольких товаров/);
      assert.match(match[3].error, /разные товары/);
      assert.match(match[4].error, /не найден/);
      assert.match(match[5].error, /Укажите/);
      assert.match(match[6].error, /не найден/, 'нашёлся товар чужого продавца');
    });
    const sellerMatch = must(await api('POST', '/api/products/match', seller, { companyId: other, lines: [{ sku: 'X-1' }, { sku: 'DR-2' }] })).items;
    check('продавец сопоставляет только со своим каталогом', () => {
      assert.ok(sellerMatch[0].error, JSON.stringify(sellerMatch));
      assert.equal(sellerMatch[1].sku, 'DR-2');
    });

    // Поставка физлицу.
    const noWhere = await api('POST', '/api/supplies/direct', owner, { companyId: company, items: [{ sku: 'DR-1', qty: 2 }] });
    const unknown = await api('POST', '/api/supplies/direct', owner, { companyId: company, destination: 'Иванов', items: [{ sku: 'X-1', qty: 1 }] });
    const twice = await api('POST', '/api/supplies/direct', owner, { companyId: company, destination: 'Иванов',
      items: [{ sku: 'DR-1', qty: 1 }, { sku: 'DR-1', qty: 1 }] });
    const zero = await api('POST', '/api/supplies/direct', owner, { companyId: company, destination: 'Иванов', items: [{ sku: 'DR-1', qty: 0 }] });
    const bySeller = await api('POST', '/api/supplies/direct', seller, { companyId: company, destination: 'Иванов', items: [{ sku: 'DR-1', qty: 1 }] });
    check('без «куда / кому», с чужим или повторным товаром, нулём или продавцом — не создаётся', () => {
      assert.equal(noWhere.status, 400);
      assert.equal(unknown.status, 400, 'чужой товар попал в поставку');
      assert.equal(twice.status, 400);
      assert.equal(zero.status, 400);
      assert.equal(bySeller.status, 403);
    });
    const supply = must(await api('POST', '/api/supplies/direct', owner, { companyId: company, destination: 'Иванов, Казань, СДЭК',
      items: [{ sku: 'DR-1', qty: 3 }, { sku: 'DR-2', qty: 1 }] }), 201);
    const order = (await run((c) => c.query(`SELECT id, number, direction, source, supply_id FROM invoices WHERE supply_id = $1`,
      [supply.id]))).rows;
    const listed = must(await api('GET', '/api/supplies', owner)).find((s) => s.id === supply.id);
    check('поставка и заказ созданы одним шагом, номер заказа — номер поставки', () => {
      assert.equal(order.length, 1);
      assert.equal(order[0].number, supply.number);
      assert.equal(order[0].direction, 'out');
      assert.equal(order[0].source, '1c');
      assert.equal(listed.destination, 'Иванов, Казань, СДЭК');
      assert.equal(listed.status, 'collecting');
      assert.equal(listed.marketplace, null);
    });
    const stockOf = async () => Object.fromEntries(must(await api('GET', '/api/sellers/stock', seller)).rows.map((r) => [r.sku, r]));
    const before = await stockOf();
    check('у продавца выбранное сразу «В сборке» и не «Доступно»', () => {
      assert.equal(before['DR-1'].inAssembly, 3);
      assert.equal(before['DR-1'].available, 7);
      assert.equal(before['DR-2'].inAssembly, 1);
    });

    // Сборка и «Уехала» — как у любой поставки, без QR WB.
    must(await api('POST', `/api/shipping/assembly/${supply.id}/start`, worker, {}), 201);
    const items = must(await api('GET', `/api/invoices/${order[0].id}`, owner)).items;
    for (const it of items) {
      must(await api('POST', '/api/shipping', worker, { invoiceItemId: it.id, pickedQty: Number(it.declared_qty), cellBlockId: cell }), 201);
    }
    const shipped = await api('POST', `/api/supplies/${supply.id}/ship`, worker, {});
    const after = await stockOf();
    const left = (await run((c) => c.query(`SELECT sku, qty FROM cell_stock WHERE company_id = $1 ORDER BY sku`, [company]))).rows
      .map((r) => `${r.sku}:${Number(r.qty)}`);
    check('собрали — «Уехала» без передачи на WB; в ячейках меньше', () => {
      assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
      assert.deepEqual(left, ['DR-1:7', 'DR-2:4']);
    });
    check('уехавшее физлицу не висит «В пути»; пока 1С его числит — не во «Всего» и не в «Доступно»', () => {
      assert.equal(after['DR-1'].inTransit, 0);
      assert.equal(after['DR-1'].inAssembly, 0);
      assert.equal(after['DR-1'].total, 7, JSON.stringify(after['DR-1']));
      assert.equal(after['DR-1'].available, 7);
      assert.equal(after['DR-2'].inTransit, 0);
    });
  } catch (e) {
    failed += 1; console.log('FAIL тест упал: ' + e.stack);
  } finally {
    server.close(); await pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})();
