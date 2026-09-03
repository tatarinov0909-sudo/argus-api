// Проверка правил Кладовщика — того слоя, который отвечает на вопросы в чате.
// Модель здесь не участвует намеренно: она только пересказывает, а проверять
// надо посчитанное. Плюс проверка, что чужой склад через эти же правила не
// виден (RLS), — подключаемся как argus_app, не как владелец таблиц.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/kladovshchik-tools-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');
const kladovshchik = require('../src/agents/kladovshchik');

const PORT = 3997;
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

function warehouseIdOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).warehouseId;
}

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();

    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Tools Owner',
        email: `tools${stamp}@test.local`,
        password: 'secret123',
        warehouseName: 'Tools WH',
        city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, `register: ${JSON.stringify(reg.body)}`);
    const ownerToken = reg.body.token;
    const warehouseId = warehouseIdOf(ownerToken);

    const company = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Ромашка' },
    });
    const companyId = company.body.id;

    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'Работник' } });
    const workerToken = (await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    })).body.token;

    await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 2, tierCount: 2 }] },
    });
    const blocks = (await api('GET', '/api/cells/rows', { token: ownerToken }))
      .body.flatMap((r) => r.blocks);

    // Приёмка с недостачей — она же наполняет ячейку и журнал.
    const inb = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId, number: `ПРХ-${stamp}`, direction: 'in',
        items: [{ name: 'Лимонад Лайм', sku: 'PB-LIME', declaredQty: 10 }],
      },
    });
    await api('POST', '/api/receiving', {
      token: workerToken,
      body: { invoiceItemId: inb.body.items[0].id, acceptedQty: 8, cellBlockId: blocks[0].id },
    });

    // Возврат, разобранный на два состояния.
    const ret = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId, number: `ВЗВ-${stamp}`, direction: 'return',
        items: [{ name: 'Лимонад Лайм', sku: 'PB-LIME', declaredQty: 5 }],
      },
    });
    const retItemId = ret.body.items[0].id;
    await api('POST', '/api/returns', {
      token: workerToken,
      body: { invoiceItemId: retItemId, qty: 3, qualityBucket: 'good', cellBlockId: blocks[0].id },
    });
    await api('POST', '/api/returns', {
      token: workerToken,
      body: { invoiceItemId: retItemId, qty: 2, qualityBucket: 'defective' },
    });

    const run = (fn) => withTenantContext({ warehouseId }, (client) => fn(client));

    // ---------- list_invoices ----------
    const all = await run((c) => kladovshchik.listInvoices(c, warehouseId, {}));
    check('видит оба документа и называет их по-человечески', () => {
      assert.equal(all.length, 2, `got ${all.length}`);
      assert.deepEqual(all.map((i) => i.kind).sort(), ['возврат', 'приёмка']);
      assert.ok(all.every((i) => i.company === 'Ромашка'));
    });

    const returnsOnly = await run((c) => kladovshchik.listInvoices(c, warehouseId, { direction: 'return' }));
    check('фильтр по направлению отсекает лишнее', () => {
      assert.equal(returnsOnly.length, 1);
      assert.equal(returnsOnly[0].kind, 'возврат');
    });

    // ---------- invoice_details ----------
    const inDetails = await run((c) => kladovshchik.invoiceDetails(c, warehouseId, `ПРХ-${stamp}`));
    check('по приёмке показывает принятое, а не только заявленное', () => {
      assert.ok(inDetails, 'документ не найден');
      assert.equal(inDetails.items[0].declaredQty, 10);
      assert.equal(inDetails.items[0].acceptedQty, 8);
      assert.equal(inDetails.items[0].pickedQty, undefined, 'у приёмки не должно быть отбора');
    });

    const retDetails = await run((c) => kladovshchik.invoiceDetails(c, warehouseId, `ВЗВ-${stamp}`));
    check('по возврату показывает разбор по состоянию', () => {
      const sorted = retDetails.items[0].sorted;
      assert.equal(sorted.length, 2, JSON.stringify(sorted));
      const byState = Object.fromEntries(sorted.map((s) => [s.state, s.qty]));
      assert.equal(byState['хороший'], 3);
      assert.equal(byState['брак'], 2);
    });

    const missing = await run((c) => kladovshchik.invoiceDetails(c, warehouseId, 'НЕТ-ТАКОЙ'));
    check('несуществующая накладная — это null, а не выдумка', () => {
      assert.equal(missing, null);
    });

    // ---------- warehouse_summary ----------
    const summary = await run((c) => kladovshchik.warehouseSummary(c, warehouseId));
    check('состояние склада считается по фактам', () => {
      assert.equal(summary.cellsTotal, 4, JSON.stringify(summary));
      assert.equal(summary.cellsOccupied, 1);
      assert.equal(summary.cellsFree, 3);
      assert.equal(summary.totalUnits, 11, '8 принятых + 3 вернувшихся годных');
      assert.equal(summary.distinctSkus, 1);
    });
    check('брак виден отдельно от годного', () => {
      const byState = Object.fromEntries(summary.returned.map((r) => [r.state, r.qty]));
      assert.equal(byState['хороший'], 3);
      assert.equal(byState['брак'], 2);
    });

    // ---------- find_products ----------
    // Товар приехал накладной, лёг в ячейку, но карточки в справочнике не
    // получил (в живой базе так было с двумя артикулами из 633). Раньше на
    // вопрос «где он?» Кладовщик отвечал «не найдено», хотя товар на полке.
    const foundBySku = await run((c) => kladovshchik.findProducts(c, warehouseId, 'PB-LIME'));
    check('находит товар, лежащий в ячейке без карточки в справочнике', () => {
      assert.equal(foundBySku.length, 1, JSON.stringify(foundBySku));
      assert.equal(foundBySku[0].totalQty, 11, '8 принятых + 3 годных из возврата');
      assert.ok(foundBySku[0].locations.length > 0, 'должен назвать ячейку');
    });

    const foundByName = await run((c) => kladovshchik.findProducts(c, warehouseId, 'Лимонад'));
    check('находит такой товар и по названию из накладной, не только по коду', () => {
      assert.equal(foundByName.length, 1, JSON.stringify(foundByName));
      assert.equal(foundByName[0].name, 'Лимонад Лайм');
    });

    const nothing = await run((c) => kladovshchik.findProducts(c, warehouseId, 'ЧЕГО-ТО-НЕТ'));
    check('несуществующий товар остаётся пустым списком', () => {
      assert.equal(nothing.length, 0);
    });

    // ---------- list_discrepancies ----------
    const problems = await run((c) => kladovshchik.listDiscrepancies(c, warehouseId, {}));
    check('недостача на приёмке попала в расхождения', () => {
      assert.equal(problems.length, 1, JSON.stringify(problems));
      assert.ok(problems[0].what.includes('PB-LIME'), problems[0].what);
      assert.equal(problems[0].agent, 'Кладовщик');
    });

    // ---------- Чужой склад ----------
    const other = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Other', email: `other${stamp}@test.local`, password: 'secret123',
        warehouseName: 'Other WH', city: 'Kazan',
      },
    });
    const otherWarehouseId = warehouseIdOf(other.body.token);

    const otherView = await withTenantContext(
      { warehouseId: otherWarehouseId },
      (c) => kladovshchik.listInvoices(c, otherWarehouseId, {}),
    );
    check('чужой склад не видит наши документы', () => {
      assert.equal(otherView.length, 0, JSON.stringify(otherView));
    });

    const otherSummary = await withTenantContext(
      { warehouseId: otherWarehouseId },
      (c) => kladovshchik.warehouseSummary(c, otherWarehouseId),
    );
    check('и не видит наш товар в сводке', () => {
      assert.equal(otherSummary.totalUnits, 0, JSON.stringify(otherSummary));
      assert.equal(otherSummary.returned.length, 0);
    });
  } catch (err) {
    failures.push({ name: 'SETUP', message: err.message });
    console.log(`\n  SETUP ERROR: ${err.message}`);
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  }
  process.exit(failures.length ? 1 : 0);
})();
