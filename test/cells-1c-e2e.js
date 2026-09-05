// Адреса хранения из 1С.
//
// Проверяется главное: адрес владельца и адрес, который видел Аргус, — ДВА
// РАЗНЫХ факта, и один не подменяет другой. Расхождение между ними означает
// «товар переставили и не записали», и его нужно замечать, а не сглаживать.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/cells-1c-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');
const kladovshchik = require('../src/agents/kladovshchik');

const PORT = 3987;
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

const whIdOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString('utf8')).warehouseId;

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', {
      body: { name: 'Cells', email: `cells${stamp}@test.local`, password: 'secret123',
              warehouseName: 'Cells WH', city: 'Moscow' },
    });
    const ownerToken = reg.body.token;
    const warehouseId = whIdOf(ownerToken);
    const run = (fn) => withTenantContext({ warehouseId }, (c) => fn(c));

    await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Ромашка' } });
    const key = await api('POST', '/api/sync/keys', { token: ownerToken, body: { label: 'Тест' } });
    const syncToken = (await api('POST', '/api/sync/auth', { body: { keyCode: key.body.key_code } })).body.token;
    const push = (path, records) => api('POST', path, {
      token: syncToken, body: { defaultCompanyName: 'Ромашка', records },
    });

    const orphan = await push('/api/sync/push/cells', [{ sku: 'PB-NONE', cell: 'А-01-02' }]);
    check('адрес без карточки товара отклоняется', () => {
      assert.equal(orphan.status, 200, JSON.stringify(orphan.body));
      assert.equal(orphan.body.results[0].status, 'error');
      assert.ok(String(orphan.body.results[0].error).includes('номенклатуру'));
    });

    await push('/api/sync/push/products', [
      { externalId: 'p-1', sku: 'PB-A', name: 'Ель Алёнушка' },
    ]);
    await push('/api/sync/push/stock', [{ sku: 'PB-A', qty: 179 }]);

    const ok = await push('/api/sync/push/cells', [
      { sku: 'PB-A', cell: 'А-01-02', qty: 100 },
      { sku: 'PB-A', cell: 'Б-07-01', qty: 79 },
    ]);
    check('адреса из 1С принимаются, товар может лежать в двух ячейках', () => {
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.results.filter((r) => r.status === 'updated').length, 2);
    });

    let found = await run((c) => kladovshchik.findProducts(c, warehouseId, 'PB-A'));
    check('Кладовщик отвечает, где лежит, ещё до единой приёмки', () => {
      const row = found.find((r) => r.sku === 'PB-A');
      assert.equal(row.cells1c.length, 2, JSON.stringify(row.cells1c));
      assert.deepEqual(row.cells1c.map((c) => c.cell).sort(), ['Б-07-01', 'А-01-02'].sort());
      assert.equal(row.locations.length, 0, 'адрес 1С подменил собой наши ячейки');
    });

    // Переставили: 1С прислала новую раскладку целиком.
    const moved = await push('/api/sync/push/cells', [{ sku: 'PB-A', cell: 'В-03-04', qty: 179 }]);
    found = await run((c) => kladovshchik.findProducts(c, warehouseId, 'PB-A'));
    check('повторная выгрузка заменяет раскладку, а не копит её', () => {
      assert.equal(moved.status, 200);
      const row = found.find((r) => r.sku === 'PB-A');
      assert.equal(row.cells1c.length, 1, JSON.stringify(row.cells1c));
      assert.equal(row.cells1c[0].cell, 'В-03-04');
    });

    // ---------- Справочник ячеек: карта склада ----------
    const cat = await push('/api/sync/push/cell-catalog', [
      { cell: '01-02-015' }, { cell: '01-02-016' }, { cell: '22-05-050' },
      { cell: 'Зона приёмки' },
    ]);
    check('справочник ячеек принимается, включая неразмеченные', () => {
      assert.equal(cat.status, 200, JSON.stringify(cat.body));
      assert.equal(cat.body.results.filter((r) => r.status === 'updated').length, 3);
      assert.equal(cat.body.results.filter((r) => r.status === 'updated_unparsed').length, 1);
    });

    const parsed = await run((c) => c.query(
      `SELECT cell_name, row_num, tier, pos FROM warehouse_cells_1c
       WHERE warehouse_id = $1 ORDER BY cell_name`, [warehouseId]));
    check('имя разбирается на ряд, ярус и место', () => {
      const one = parsed.rows.find((r) => r.cell_name === '01-02-015');
      assert.equal(one.row_num, 1, 'ряд');
      assert.equal(one.tier, 2, 'ярус');
      assert.equal(one.pos, 15, 'ячейка');
    });
    check('и ведущие нули не теряются — на табличке написано именно так', () => {
      assert.ok(parsed.rows.some((r) => r.cell_name === '01-02-015'));
    });
    check('ячейка без разметки остаётся, но без координат', () => {
      const z = parsed.rows.find((r) => r.cell_name === 'Зона приёмки');
      assert.ok(z, 'потеряли ячейку, имя которой не в формате');
      assert.equal(z.row_num, null);
    });

    const asOwner = await api('POST', '/api/sync/push/cells', {
      token: ownerToken, body: { records: [{ sku: 'PB-A', cell: 'Х-1' }] },
    });
    check('адреса шлёт только обмен, не владелец из браузера', () => {
      assert.equal(asOwner.status, 403, JSON.stringify(asOwner.body));
    });
  } finally { server.close(); }
  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
