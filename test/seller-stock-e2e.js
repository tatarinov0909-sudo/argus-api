// Четыре числа в кабинете продавца и арифметика между ними.
//
// Проверяется не «показывается ли цифра», а то, на чём теряют доверие и товар:
//   1. «Заказано» и «В сборке» уменьшают доступное к продаже, и ровно один раз:
//      пока заказ не в поставке — он «заказан», попал в поставку — «в сборке»;
//   2. после отгрузки и следующего обмена с 1С числа сходятся;
//   3. продавец видит СВОЙ товар и ничей больше — и это решает Postgres,
//      а не фильтр в коде;
//   4. внутренности склада (ячейки, брак, цифра 1С) продавцу не уезжают.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/seller-stock-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');

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

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

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
  const must = async (...args) => {
    const r = await api(...args);
    assert.ok(r.status < 300, `${args[1]} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  try {
    const stamp = Date.now();
    const reg = await must('POST', '/api/auth/owner/register', {
      body: {
        name: 'Stock Owner', email: `stock${stamp}@test.local`, password: 'secret123',
        warehouseName: 'Stock WH', city: 'Moscow',
      },
    });
    const ownerToken = reg.token;

    const alpha = await must('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Альфа' } });
    const beta = await must('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Бета' } });
    const alphaKey = await must('POST', `/api/sellers/companies/${alpha.id}/keys`, { token: ownerToken });
    // Продавец входит по ключу И называет себя: журнал должен знать, кто именно.
    const alphaToken = (await must('POST', '/api/auth/seller/login',
      { body: { keyCode: alphaKey.key_code, name: 'Пётр' } })).token;
    const staff = await must('POST', '/api/staff', { token: ownerToken, body: { name: 'Работник' } });
    const workerToken = (await must('POST', '/api/auth/staff/login',
      { body: { keyCode: staff.key_code } })).token;

    await must('POST', '/api/cells/rows', { token: ownerToken, body: { configs: [{ rackCount: 3, tierCount: 2 }] } });
    const blocks = (await must('GET', '/api/cells/rows', { token: ownerToken })).flatMap((r) => r.blocks);

    async function receive(companyId, sku, name, qty, cellId, num) {
      const inv = await must('POST', '/api/invoices', {
        token: ownerToken,
        body: { companyId, number: num, direction: 'in', items: [{ name, sku, declaredQty: qty }] },
      });
      await must('POST', '/api/receiving', {
        token: workerToken,
        body: { invoiceItemId: inv.items[0].id, acceptedQty: qty, cellBlockId: cellId },
      });
    }
    await receive(alpha.id, 'PB-A', 'Печенье овсяное', 100, blocks[0].id, `ПРХ-A-${stamp}`);
    await receive(beta.id, 'PB-B', 'Чужой товар', 55, blocks[1].id, `ПРХ-B-${stamp}`);

    // «Всего» продавцу даёт учёт 1С: это его товар в учёте склада.
    const syncKey = await must('POST', '/api/sync/keys', { token: ownerToken, body: { label: 'Тест остатков' } });
    const syncToken = (await must('POST', '/api/sync/auth', { body: { keyCode: syncKey.key_code } })).token;
    await must('POST', '/api/sync/push/companies', {
      token: syncToken, body: { records: [{ externalId: 'company-alpha', name: 'Альфа' }] },
    });
    const pushStock = (records) => must('POST', '/api/sync/push/stock', {
      token: syncToken,
      body: { records: records.map((r) => ({ ...r, companyExternalId: 'company-alpha' })) },
    });
    await must('POST', '/api/sync/push/products', {
      token: syncToken,
      body: {
        records: [
          { externalId: 'p-a', sku: 'PB-A', name: 'Печенье овсяное', companyExternalId: 'company-alpha' },
          { externalId: 'p-only1c', sku: 'PB-ONLY-1C', name: 'Только в 1С', companyExternalId: 'company-alpha' },
        ],
      },
    });
    await pushStock([{ sku: 'PB-A', qty: 100 }, { sku: 'PB-ONLY-1C', qty: 700 }]);

    const sellerStock = () => must('GET', '/api/sellers/stock', { token: alphaToken });
    const rowOf = (payload, sku) => payload.rows.find((r) => r.sku === sku);

    const start = await sellerStock();
    check('продавец видит свои товары четырьмя числами', () => {
      const a = rowOf(start, 'PB-A');
      assert.ok(a, JSON.stringify(start));
      assert.equal(a.total, 100);
      assert.equal(a.ordered, 0);
      assert.equal(a.inAssembly, 0);
      assert.equal(a.available, 100);
      assert.equal(rowOf(start, 'PB-ONLY-1C').total, 700, 'товар из 1С без ячеек не показан');
    });
    check('и чужого не видит', () => {
      assert.ok(!rowOf(start, 'PB-B'), 'в остатке продавца оказался чужой товар');
    });
    check('внутренности склада продавцу не уезжают', () => {
      const a = rowOf(start, 'PB-A');
      for (const field of ['qtyIn1c', 'cells', 'onHand', 'notForSale', 'stockAt', 'short']) {
        assert.ok(!Object.hasOwn(a, field), `продавцу ушло поле склада: ${field}`);
      }
    });
    check('сводка складывает те же числа', () => {
      assert.equal(start.summary.total, 800);
      assert.equal(start.summary.available, 800);
      assert.equal(start.summary.productCount, 2);
    });

    // ---------- Купили на площадке: «заказано» ----------
    const order = await must('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: alpha.id, number: `WB-${stamp}`, direction: 'out',
        items: [{ name: 'Печенье овсяное', sku: 'PB-A', declaredQty: 30 }],
      },
    });
    const queued = await sellerStock();
    check('новый заказ становится «заказано» и уменьшает доступное', () => {
      const a = rowOf(queued, 'PB-A');
      assert.equal(a.total, 100, '«всего» от заказа меняться не должно');
      assert.equal(a.ordered, 30, JSON.stringify(a));
      assert.equal(a.inAssembly, 0, 'склад его ещё не получал');
      assert.equal(a.available, 70);
      assert.ok(a.orderedOrders >= 1, 'не сказано, сколькими заказами это обещано');
    });

    // ---------- Менеджер отдал поставку складу: «в сборке» ----------
    const supply = await must('POST', '/api/supplies', { token: ownerToken, body: { invoiceIds: [order.id] } });
    const inSupply = await sellerStock();
    check('поставка передана на склад — то же количество стало «в сборке»', () => {
      const a = rowOf(inSupply, 'PB-A');
      assert.equal(a.ordered, 0, 'заказ остался и в «заказано», и в «в сборке» — двойной вычет');
      assert.equal(a.inAssembly, 30, JSON.stringify(a));
      assert.equal(a.available, 70, 'доступное должно уменьшиться ровно один раз');
      assert.ok(a.assemblyOrders >= 1);
    });

    // ---------- Отбор с полки ничего не обещает заново ----------
    await must('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: order.items[0].id, pickedQty: 30, cellBlockId: blocks[0].id },
    });
    const afterPick = await sellerStock();
    check('отбор с полки не меняет обещанного покупателям', () => {
      const a = rowOf(afterPick, 'PB-A');
      assert.equal(a.inAssembly, 30, JSON.stringify(a));
      assert.equal(a.available, 70);
    });

    // ---------- Уехало: числа сходятся после следующего обмена с 1С ----------
    await must('POST', `/api/supplies/${supply.id}/ship`, { token: ownerToken, body: { destination: 'СЦ' } });
    await pushStock([{ sku: 'PB-A', qty: 70 }]);
    const afterShip = await sellerStock();
    check('после отгрузки и обмена с 1С остаток уменьшился, обещаний больше нет', () => {
      const a = rowOf(afterShip, 'PB-A');
      assert.equal(a.total, 70, JSON.stringify(a));
      assert.equal(a.ordered, 0);
      assert.equal(a.inAssembly, 0);
      assert.equal(a.available, 70);
    });

    // ---------- Брак: продавцу видно в движении, а не в остатке ----------
    const ret = await must('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: alpha.id, number: `ВЗВ-${stamp}`, direction: 'return',
        items: [{ name: 'Печенье овсяное', sku: 'PB-A', declaredQty: 9 }],
      },
    });
    await must('POST', '/api/returns', {
      token: workerToken,
      body: { invoiceItemId: ret.items[0].id, qty: 9, qualityBucket: 'defective', cellBlockId: blocks[2].id },
    });
    const ownerView = await must('GET', `/api/sellers/stock?companyId=${alpha.id}`, { token: ownerToken });
    check('владелец видит склад целиком: ячейки, брак и цифру 1С', () => {
      const a = ownerView.find((r) => r.sku === 'PB-A');
      assert.equal(a.qty, 70, 'годное в ячейках');
      assert.equal(a.notForSale, 9, 'брак показан отдельно');
      assert.equal(a.qtyIn1c, 70);
      assert.ok(a.cells >= 1);
    });
    const moves = await must('GET', '/api/sellers/movements', { token: alphaToken });
    check('продавец видит свою отгрузку и свой возврат с его качеством', () => {
      assert.equal(moves.shipped.length, 1, JSON.stringify(moves.shipped));
      assert.equal(moves.shipped[0].qty, 30);
      assert.equal(moves.returned.length, 1, JSON.stringify(moves.returned));
      assert.equal(moves.returned[0].bucket, 'defective');
    });

    // ---------- Товар, которого нет в учёте, продавцу не придумывается ----------
    await must('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: alpha.id, number: `WB-GHOST-${stamp}`, direction: 'out',
        items: [{ name: 'Товар только в заказе', sku: 'PB-ONLY-ORDER', declaredQty: 7 }],
      },
    });
    const withGhost = await sellerStock();
    check('заказ на неизвестный складу товар не создаёт остаток из воздуха', () => {
      assert.ok(!rowOf(withGhost, 'PB-ONLY-ORDER'), JSON.stringify(withGhost.rows));
      const orders = withGhost.rows.map((r) => r.sku);
      assert.ok(orders.includes('PB-A'), 'настоящие товары остались на месте');
    });

    // ---------- Изоляция ----------
    const peek = await api('GET', `/api/sellers/stock?companyId=${beta.id}`, { token: alphaToken });
    check('подставить чужую компанию в запрос бесполезно', () => {
      assert.equal(peek.status, 200, JSON.stringify(peek.body));
      assert.ok(!peek.body.rows.some((r) => r.sku === 'PB-B'),
        'параметр запроса пересилил изоляцию — это утечка между продавцами');
    });
    const ownerNoCompany = await api('GET', '/api/sellers/stock', { token: ownerToken });
    check('владелец обязан назвать, чьими глазами смотрит', () => {
      assert.equal(ownerNoCompany.status, 400, JSON.stringify(ownerNoCompany.body));
    });
    const worker = await api('GET', '/api/sellers/stock', { token: workerToken });
    check('работнику остаток продавца не показывают', () => {
      assert.equal(worker.status, 403, JSON.stringify(worker.body));
    });
    const betaKey = await must('POST', `/api/sellers/companies/${beta.id}/keys`, { token: ownerToken });
    const betaToken = (await must('POST', '/api/auth/seller/login',
      { body: { keyCode: betaKey.key_code, name: 'Иван' } })).token;
    const betaMoves = await must('GET', '/api/sellers/movements', { token: betaToken });
    check('чужое движение продавцу не видно', () => {
      assert.equal(betaMoves.shipped.length, 0, JSON.stringify(betaMoves.shipped));
      assert.equal(betaMoves.returned.length, 0, JSON.stringify(betaMoves.returned));
    });

    // ---------- Отзыв ключа действует сразу ----------
    // Раньше отзыв закрывал только вход, а выданный токен жил до конца срока —
    // до 45 минут. Отзывают ключ обычно тогда, когда этих минут и нет.
    await must('PATCH', `/api/sellers/keys/${alphaKey.id}/toggle`, { token: ownerToken });
    await new Promise((r) => setTimeout(r, 2100)); // короткий кэш проверки ключа
    const afterRevoke = await api('GET', '/api/sellers/stock', { token: alphaToken });
    check('после отзыва ключа старый токен перестаёт работать', () => {
      assert.equal(afterRevoke.status, 401, JSON.stringify(afterRevoke.body));
    });
    const relogin = await api('POST', '/api/auth/seller/login',
      { body: { keyCode: alphaKey.key_code, name: 'Пётр' } });
    check('и войти заново по нему нельзя', () => {
      assert.equal(relogin.status, 403, JSON.stringify(relogin.body));
    });
    const ownerStillWorks = await api('GET', `/api/sellers/stock?companyId=${alpha.id}`, { token: ownerToken });
    check('владельца отзыв чужого ключа не задевает', () => {
      assert.equal(ownerStillWorks.status, 200, JSON.stringify(ownerStillWorks.body));
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
