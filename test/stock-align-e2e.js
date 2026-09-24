// Сверка остатков продавца с документом 1С: товар из документа переходит к
// продавцу (в том числе из обмена 1С без владельца), артикул становится
// артикулом WB, ячейки выравниваются, собранное-но-не-уехавшее не задваивается.
const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');

const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', {
      body: { name: 'Align', email: `align${stamp}@test.local`, password: 'secret123', warehouseName: 'Align WH', city: 'Moscow' },
    });
    const token = reg.body.token;
    const warehouseId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).warehouseId;
    const seller = (await api('POST', '/api/sellers/companies', { token, body: { name: 'Слим' } })).body.id;
    await api('POST', '/api/cells/rows', { token, body: { configs: [{ rackCount: 3, tierCount: 2 }] } });
    const blocks = (await api('GET', '/api/cells/rows', { token })).body.flatMap((r) => r.blocks);
    const run = (fn) => withTenantContext({ warehouseId }, fn);

    await api('POST', '/api/products', { token, body: { companyId: seller, sku: `PB-A${stamp}`, name: 'Печенье' } });
    // Карточка из обмена 1С без владельца — как новые товары после 24.09.
    await run((c) => c.query(
      `INSERT INTO products (warehouse_id, company_id, sku, name, external_id) VALUES ($1, NULL, $2, 'Лимонад 330мл 2049388157683', $3)`,
      [warehouseId, `PB-B${stamp}`, `ext-${stamp}`]));
    await run((c) => c.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1, $2, $3, $4, 50), ($5, $2, $3, $4, 10)`,
      [blocks[0].id, warehouseId, seller, `PB-A${stamp}`, blocks[1].id]));

    const grid = [
      [null, 'Ведомость по товарам на складах'],
      [null, 'Номенклатура.Артикул ', 'Количество'],
      [null, 'Номенклатура.Код', 'Приход', 'Расход', 'Конечный остаток'],
      [null, 'Номенклатура, Базовая единица измерения'],
      [null, 1201001101, null, null, 45],
      [null, `PB-A${stamp}`, null, null, 45],
      [null, 'Печенье, шт', null, null, 45],
      [null, 1201001102, null, null, 7],
      [null, `PB-B${stamp}`, null, null, 7],
      [null, 'Лимонад 330мл 2049388157683, шт', null, null, 7],
    ];
    const preview = await api('POST', '/api/cells/stock-align', { token, body: { companyId: seller, grid } });
    check('предпросмотр ничего не пишет и видит оба товара', () => {
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body.applied, false);
      assert.equal(preview.body.summary.records, 2);
      assert.equal(preview.body.summary.notFound, 0);
    });

    // Собранное, но не уехавшее: 3 шт. печенья уже на столе.
    const order = await api('POST', '/api/invoices', { token, body: { companyId: seller, number: `O-${stamp}`, direction: 'out',
      items: [{ name: 'Печенье', sku: `PB-A${stamp}`, declaredQty: 3 }] } });
    await run((c) => c.query(`UPDATE invoices SET source = '1c' WHERE id = $1`, [order.body.id]));
    const staff = await api('POST', '/api/staff', { token, body: { name: 'Грузчик' } });
    const worker = (await api('POST', '/api/auth/staff/login', { body: { keyCode: staff.body.key_code } })).body.token;
    const pick = await api('POST', '/api/shipping', { token: worker,
      body: { invoiceItemId: order.body.items[0].id, pickedQty: 3, cellBlockId: blocks[0].id } });
    assert.equal(pick.status, 201, JSON.stringify(pick.body));

    const applied = await api('POST', '/api/cells/stock-align', { token, body: { companyId: seller, grid, apply: true, placeNew: true } });
    const state = await run(async (c) => ({
      cellsA: Number((await c.query('SELECT COALESCE(SUM(qty),0) q FROM cell_stock WHERE company_id=$1 AND sku=$2', [seller, `PB-A${stamp}`])).rows[0].q),
      cellsB: Number((await c.query('SELECT COALESCE(SUM(qty),0) q FROM cell_stock WHERE company_id=$1 AND sku=$2', [seller, `PB-B${stamp}`])).rows[0].q),
      ownerB: (await c.query('SELECT company_id FROM products WHERE sku=$1', [`PB-B${stamp}`])).rows[0].company_id,
      mapA: (await c.query(`SELECT mp_article FROM product_marketplace_skus WHERE company_id=$1 AND sku=$2`, [seller, `PB-A${stamp}`])).rows[0],
    }));
    check('запись прошла', () => assert.equal(applied.status, 200, JSON.stringify(applied.body)));
    check('ячейки = документ минус собранное: 45 − 3 = 42', () => assert.equal(state.cellsA, 42));
    check('карточка из обмена без владельца перешла к продавцу', () => assert.equal(state.ownerB, seller));
    check('товар без ячейки лёг в свободную, как просили', () => assert.equal(state.cellsB, 7));
    check('артикул документа стал артикулом WB', () => assert.equal(state.mapA && state.mapA.mp_article, '1201001101'));

    const again = await api('POST', '/api/cells/stock-align', { token, body: { companyId: seller, grid } });
    check('повторная сверка — менять нечего', () => assert.equal(again.body.summary.changed, 0, JSON.stringify(again.body.summary)));
    const worker403 = await api('POST', '/api/cells/stock-align', { token: worker, body: { companyId: seller, grid } });
    check('работнику сверка недоступна', () => assert.equal(worker403.status, 403));
  } finally { server.close(); }
  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
