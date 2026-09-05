// Остатки из 1С.
//
// Проверяется не «сохранилось ли число», а то, из-за чего этот кусок вообще
// появился: до него пути для настоящих остатков не существовало, а в базе
// лежала одна вставка выдуманных. Поэтому здесь важнее всего, что остаток 1С
// и остаток по ячейкам — ДВА РАЗНЫХ факта и один не подменяет другой.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/stock-sync-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');
const kladovshchik = require('../src/agents/kladovshchik');

const PORT = 3981;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const whIdOf = (token) => JSON.parse(
  Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
).warehouseId;

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Stock Sync', email: `ss${stamp}@test.local`, password: 'secret123',
        warehouseName: 'SS WH', city: 'Moscow',
      },
    });
    const ownerToken = reg.body.token;
    const warehouseId = whIdOf(ownerToken);
    const run = (fn) => withTenantContext({ warehouseId }, (c) => fn(c));

    const company = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Ромашка' },
    });
    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'Работник' } });
    const workerToken = (await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    })).body.token;
    await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 2, tierCount: 2 }] },
    });
    const blocks = (await api('GET', '/api/cells/rows', { token: ownerToken }))
      .body.flatMap((r) => r.blocks);

    const key = await api('POST', '/api/sync/keys', { token: ownerToken, body: { label: 'Тест' } });
    const syncToken = (await api('POST', '/api/sync/auth', {
      body: { keyCode: key.body.key_code },
    })).body.token;

    const push = (path, records) => api('POST', path, {
      token: syncToken, body: { defaultCompanyName: 'Ромашка', records },
    });

    // ---------- Остаток без номенклатуры принять нельзя ----------
    const orphan = await push('/api/sync/push/stock', [{ sku: 'PB-NONE', qty: 10 }]);
    check('остаток без карточки товара отклоняется, а не создаёт её', () => {
      assert.equal(orphan.status, 200, JSON.stringify(orphan.body));
      assert.equal(orphan.body.results[0].status, 'error');
      assert.ok(String(orphan.body.results[0].error).includes('номенклатуру'),
        orphan.body.results[0].error);
    });

    await push('/api/sync/push/products', [
      { externalId: 'p-1', sku: 'PB-A', name: 'Печенье овсяное' },
      { externalId: 'p-2', sku: 'PB-B', name: 'Мармелад' },
    ]);

    // ---------- Остаток приходит и ложится ----------
    const pushed = await push('/api/sync/push/stock', [
      { sku: 'PB-A', qty: 500 },
      { sku: 'PB-B', qty: 40 },
    ]);
    check('остатки из 1С принимаются', () => {
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
      assert.equal(pushed.body.results.filter((r) => r.status === 'updated').length, 2);
    });

    const found = await run((c) => kladovshchik.findProducts(c, warehouseId, 'PB-A'));
    check('в 1С числится 500, а по ячейкам — ноль, и это разные числа', () => {
      const row = found.find((r) => r.sku === 'PB-A');
      assert.equal(row.stockIn1c, 500, 'остаток 1С не доехал');
      assert.equal(row.totalQty, 0, 'остаток 1С молча разложили по ячейкам — это и есть выдумка');
    });
    check('и видно, когда 1С это сказала', () => {
      assert.ok(found.find((r) => r.sku === 'PB-A').stockAt,
        'без отметки времени нельзя отличить «ноль» от «давно не присылали»');
    });

    // ---------- Приёмка наполняет ячейки, не трогая цифру 1С ----------
    const inv = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: company.body.id, number: `ПРХ-${stamp}`, direction: 'in',
        items: [{ name: 'Печенье овсяное', sku: 'PB-A', declaredQty: 480 }],
      },
    });
    await api('POST', '/api/receiving', {
      token: workerToken,
      body: { invoiceItemId: inv.body.items[0].id, acceptedQty: 480, cellBlockId: blocks[0].id },
    });

    const afterReceive = await run((c) => kladovshchik.findProducts(c, warehouseId, 'PB-A'));
    check('после приёмки по ячейкам 480, а в 1С по-прежнему 500', () => {
      const row = afterReceive.find((r) => r.sku === 'PB-A');
      assert.equal(row.totalQty, 480);
      assert.equal(row.stockIn1c, 500, 'приёмка переписала цифру 1С — она не наша');
    });

    // ---------- Снимок перезаписывается, а не накапливается ----------
    await push('/api/sync/push/stock', [{ sku: 'PB-A', qty: 300 }]);
    const afterSecond = await run((c) => kladovshchik.findProducts(c, warehouseId, 'PB-A'));
    check('повторная выгрузка заменяет снимок, а не прибавляет к нему', () => {
      assert.equal(afterSecond.find((r) => r.sku === 'PB-A').stockIn1c, 300);
    });

    // ---------- Чужие роли ----------
    const asOwner = await api('POST', '/api/sync/push/stock', {
      token: ownerToken, body: { records: [{ sku: 'PB-A', qty: 1 }] },
    });
    check('остатки может присылать только обмен, не владелец из браузера', () => {
      assert.equal(asOwner.status, 403, JSON.stringify(asOwner.body));
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
