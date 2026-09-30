// Склад без 1С (анкета склада: учёт «только в Аргусе», владелец 30.09.2026):
// четыре числа продавца считаются по ячейкам Аргуса.
//   «Всего» — годное в ячейках + собранное, но не уехавшее;
//   «Доступно» = «Всего» − «Заказано» − «В сборке»;
//   товар, которого склад не видел, — «не знаем», а не ноль;
//   склад с 1С — как раньше: «Всего» из 1С, ячейки на него не влияют.

const assert = require('node:assert');
const { createApp } = require('../src/app');
const sync = require('../src/marketplaces/sync');
const { withTenantContext } = require('../src/db/pool');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, path, { token, body } = {}) {
    const res = await fetch(BASE + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json };
  }
  const must = async (...args) => {
    const r = await api(...args);
    assert.ok(r.status < 300, `${args[1]} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  try {
    const stamp = Date.now();
    const reg = await must('POST', '/api/auth/owner/register', { body: {
      name: 'Cells Owner', email: `cells${stamp}@test.local`, password: 'secret123', warehouseName: 'Ромашка', city: 'Казань' } });
    const owner = reg.token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64').toString('utf8')).warehouseId;
    const alpha = await must('POST', '/api/sellers/companies', { token: owner, body: { name: 'Альфа' } });
    const key = await must('POST', `/api/sellers/companies/${alpha.id}/keys`, { token: owner });
    const seller = (await must('POST', '/api/auth/seller/login', { body: { keyCode: key.key_code, name: 'Пётр' } })).token;
    const staff = await must('POST', '/api/staff', { token: owner, body: { name: 'Работник' } });
    const worker = (await must('POST', '/api/auth/staff/login', { body: { keyCode: staff.key_code } })).token;
    await must('POST', '/api/cells/rows', { token: owner, body: { configs: [{ rackCount: 2, tierCount: 1 }] } });
    const blocks = (await must('GET', '/api/cells/rows', { token: owner })).flatMap((r) => r.blocks);
    await must('POST', '/api/products', { token: owner, body: { companyId: alpha.id, sku: 'PB-A', name: 'Печенье' } });
    await must('POST', '/api/products', { token: owner, body: { companyId: alpha.id, sku: 'PB-NEW', name: 'Ещё не привезли' } });

    const stock = () => must('GET', '/api/sellers/stock', { token: seller });
    const rowOf = (p, sku) => p.rows.find((r) => r.sku === sku);

    // Анкета ещё не заполнена — как склад с 1С: «Всего» не знаем.
    const before = await stock();
    check('без ответа анкеты и без 1С «Всего» — «не знаем»', () => assert.equal(rowOf(before, 'PB-A').total, null));

    await must('PATCH', '/api/warehouses/me', { token: owner, body: { stockSource: 'argus', setupDone: true } });
    const inv = await must('POST', '/api/invoices', { token: owner,
      body: { companyId: alpha.id, number: `ПРХ-${stamp}`, direction: 'in', items: [{ name: 'Печенье', sku: 'PB-A', declaredQty: 100 }] } });
    await api('POST', `/api/receiving/session/${inv.id}/start`, { token: worker });
    await must('POST', '/api/receiving', { token: worker,
      body: { invoiceItemId: inv.items[0].id, acceptedQty: 100, cellBlockId: blocks[0].id } });

    // Два заказа WB: оба «заказано».
    await withTenantContext({ warehouseId }, (c) => sync.importOrders(c, warehouseId, { companyId: alpha.id, orders: [1, 2].map((n) => ({
      externalId: `${stamp}${n}`, article: 'PB-A', nmId: null, barcodes: [], rid: `r${stamp}${n}`, salePriceKopecks: 100,
      createdAt: new Date().toISOString(), offices: [], warehouseId: null, chrtId: null,
    })) }));
    await withTenantContext({ warehouseId }, (c) => c.query(
      `INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article)
       VALUES ($1, $2, 'PB-A', 'wb', 'nm-a', 'PB-A')`, [warehouseId, alpha.id]));

    const after = await stock();
    const a = rowOf(after, 'PB-A');
    check('склад без 1С: «Всего» — годное в ячейках', () => {
      assert.equal(a.total, 100);
      assert.equal(a.ordered, 2);
      assert.equal(a.available, 98);
    });
    check('дата учёта — когда товар видели в ячейках', () => assert.ok(a.updatedAt));
    check('товар, которого склад не видел, — «не знаем», а не ноль', () => assert.equal(rowOf(after, 'PB-NEW').total, null));
    check('итог продавца считается по ячейкам', () => {
      assert.equal(after.summary.total, 100);
      assert.equal(after.summary.available, 98);
    });

    // Склад передумал: учёт в 1С. Числа 1С нет — «Всего» снова «не знаем»,
    // ячейки его не подменяют.
    await must('PATCH', '/api/warehouses/me', { token: owner, body: { stockSource: '1c' } });
    const back = await stock();
    check('вернулись к 1С — «Всего» только из 1С, ячейки его не подменяют', () => {
      assert.equal(rowOf(back, 'PB-A').total, null);
      assert.equal(rowOf(back, 'PB-A').available, null);
    });
    // Пояс склада: номер поставки — по дню склада. UTC+14: почти весь день
    // это уже «завтра» по Москве.
    const zone = 'Pacific/Kiritimati';
    await must('PATCH', '/api/warehouses/me', { token: owner, body: { timezone: zone } });
    const one = (await must('GET', `/api/supplies/pending/${alpha.id}`, { token: owner })).find((o) => o.ready);
    const supply = await must('POST', '/api/supplies', { token: owner,
      body: { invoiceIds: [one.id], marketplace: 'wb', destination: 'Коледино' } });
    const [y, m, d] = require('../src/warehouses/time').todayIn(zone).split('-');
    check('номер поставки — по дню в поясе склада', () => assert.ok(supply.number.startsWith(`ПС-${d}${m}${y.slice(2)}-`), supply.number));

    const totals = await must('GET', '/api/warehouses/me/stock-sources', { token: owner });
    check('сверка перед сменой учёта: в ячейках 100, по 1С 0', () => {
      assert.equal(totals.cells, 100);
      assert.equal(totals.onec, 0);
    });
  } catch (err) {
    failures.push({ name: 'тест упал', message: err.stack });
    console.log(err.stack);
  } finally {
    server.close();
    const { pool } = require('../src/db/pool');
    await pool.end();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
