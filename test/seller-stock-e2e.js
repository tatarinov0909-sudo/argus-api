// Настоящий остаток в кабинете продавца.
//
// Главное, что здесь проверяется, — не «показывается ли цифра», а две вещи,
// на которых легко потерять доверие клиента и его товар:
//   1. остаток уменьшается после отгрузки (раньше он только рос, потому что
//      считался нарастающим итогом по приёмкам);
//   2. продавец видит СВОЙ товар и ничей больше — и это решает Postgres,
//      а не фильтр в коде.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/seller-stock-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');

const PORT = 3983;
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

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Stock Owner', email: `stock${stamp}@test.local`, password: 'secret123',
        warehouseName: 'Stock WH', city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const ownerToken = reg.body.token;

    const alpha = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Альфа' } });
    const beta = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Бета' } });

    const alphaKey = await api('POST', `/api/sellers/companies/${alpha.body.id}/keys`, { token: ownerToken });
    // Продавец входит по ключу И называет себя: журнал должен знать, кто
    // именно из компании смотрел.
    const alphaLogin = await api('POST', '/api/auth/seller/login', {
      body: { keyCode: alphaKey.body.key_code, name: 'Пётр' },
    });
    assert.equal(alphaLogin.status, 200, JSON.stringify(alphaLogin.body));
    const alphaToken = alphaLogin.body.token;

    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'Работник' } });
    const workerToken = (await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    })).body.token;

    await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 3, tierCount: 2 }] },
    });
    const blocks = (await api('GET', '/api/cells/rows', { token: ownerToken }))
      .body.flatMap((r) => r.blocks);

    async function receive(companyId, sku, name, qty, cellId, num) {
      const inv = await api('POST', '/api/invoices', {
        token: ownerToken,
        body: { companyId, number: num, direction: 'in', items: [{ name, sku, declaredQty: qty }] },
      });
      const res = await api('POST', '/api/receiving', {
        token: workerToken,
        body: { invoiceItemId: inv.body.items[0].id, acceptedQty: qty, cellBlockId: cellId },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }

    await receive(alpha.body.id, 'PB-A', 'Печенье овсяное', 100, blocks[0].id, `ПРХ-A-${stamp}`);
    await receive(beta.body.id, 'PB-B', 'Чужой товар', 55, blocks[1].id, `ПРХ-B-${stamp}`);

    const afterReceive = await api('GET', '/api/sellers/stock', { token: alphaToken });
    check('продавец видит свой остаток', () => {
      assert.equal(afterReceive.status, 200, JSON.stringify(afterReceive.body));
      assert.equal(afterReceive.body.length, 1, JSON.stringify(afterReceive.body));
      assert.equal(afterReceive.body[0].sku, 'PB-A');
      assert.equal(afterReceive.body[0].qty, 100);
    });
    check('и чужого не видит', () => {
      assert.ok(!afterReceive.body.some((r) => r.sku === 'PB-B'),
        'в остатке продавца оказался чужой товар');
    });
    check('видно, в скольких ячейках товар лежит', () => {
      assert.equal(afterReceive.body[0].cells, 1);
    });

    // ---------- Главное: отгрузка уменьшает остаток ----------
    const order = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: alpha.body.id, number: `ЗАК-${stamp}`, direction: 'out',
        items: [{ name: 'Печенье овсяное', sku: 'PB-A', declaredQty: 30 }],
      },
    });
    const shipped = await api('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: order.body.items[0].id, pickedQty: 30, cellBlockId: blocks[0].id },
    });
    assert.equal(shipped.status, 201, JSON.stringify(shipped.body));

    const afterShip = await api('GET', '/api/sellers/stock', { token: alphaToken });
    check('после отгрузки остаток УМЕНЬШИЛСЯ', () => {
      assert.equal(afterShip.body[0].qty, 70,
        'остаток не вычитает отгрузки — та самая ошибка, ради которой всё делалось');
    });

    // ---------- Брак виден отдельно ----------
    const ret = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: alpha.body.id, number: `ВЗВ-${stamp}`, direction: 'return',
        items: [{ name: 'Печенье овсяное', sku: 'PB-A', declaredQty: 9 }],
      },
    });
    await api('POST', '/api/returns', {
      token: workerToken,
      body: {
        invoiceItemId: ret.body.items[0].id, qty: 9,
        qualityBucket: 'defective', cellBlockId: blocks[2].id,
      },
    });
    const withDefect = await api('GET', '/api/sellers/stock', { token: alphaToken });
    check('брак не подмешивается к тому, что можно продать', () => {
      const row = withDefect.body.find((r) => r.sku === 'PB-A');
      assert.equal(row.qty, 70, 'брак посчитали как годное');
      assert.equal(row.notForSale, 9, 'брак не показан отдельно');
    });

    // ---------- Владелец смотрит глазами продавца ----------
    const asOwner = await api('GET', `/api/sellers/stock?companyId=${alpha.body.id}`, { token: ownerToken });
    check('владелец может посмотреть, что видит его клиент', () => {
      assert.equal(asOwner.status, 200, JSON.stringify(asOwner.body));
      assert.equal(asOwner.body.find((r) => r.sku === 'PB-A').qty, 70);
    });
    const ownerNoCompany = await api('GET', '/api/sellers/stock', { token: ownerToken });
    check('но обязан назвать, чьими глазами', () => {
      assert.equal(ownerNoCompany.status, 400, JSON.stringify(ownerNoCompany.body));
    });

    // ---------- Продавец не может подсмотреть чужой остаток ----------
    const peek = await api('GET', `/api/sellers/stock?companyId=${beta.body.id}`, { token: alphaToken });
    check('подставить чужую компанию в запрос бесполезно', () => {
      assert.equal(peek.status, 200, JSON.stringify(peek.body));
      assert.ok(!peek.body.some((r) => r.sku === 'PB-B'),
        'параметр запроса пересилил изоляцию — это утечка между продавцами');
    });

    const worker = await api('GET', '/api/sellers/stock', { token: workerToken });
    check('работнику остаток продавца не показывают', () => {
      assert.equal(worker.status, 403, JSON.stringify(worker.body));
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
