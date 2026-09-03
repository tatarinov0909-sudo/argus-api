// Перемещение/перепаковка и «лист грузчика» — два правила с арифметикой,
// где ошибка стоит дорого: в первом товар может исчезнуть или размножиться,
// во втором работник пойдёт не туда или не за тем количеством.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/move-picklist-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');

const PORT = 3993;
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
        name: 'Move Owner', email: `move${stamp}@test.local`, password: 'secret123',
        warehouseName: 'Move WH', city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const ownerToken = reg.body.token;

    const companyA = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Альфа' } });
    const companyB = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Бета' } });
    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'Работник' } });
    const workerToken = (await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    })).body.token;

    await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 3, tierCount: 2 }, { rackCount: 3, tierCount: 2 }] },
    });
    const blocks = (await api('GET', '/api/cells/rows', { token: ownerToken }))
      .body.flatMap((r) => r.blocks);
    const [c1, c2, c3] = blocks;

    async function receive(companyId, sku, name, qty, cellId, num) {
      const inv = await api('POST', '/api/invoices', {
        token: ownerToken,
        body: { companyId, number: num, direction: 'in', items: [{ name, sku, declaredQty: qty }] },
      });
      const rec = await api('POST', '/api/receiving', {
        token: workerToken,
        body: { invoiceItemId: inv.body.items[0].id, acceptedQty: qty, cellBlockId: cellId },
      });
      assert.equal(rec.status, 201, JSON.stringify(rec.body));
    }

    // ---------- Перепаковка: брак упаковки → годный ----------
    const ret = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: companyA.body.id, number: `ВЗВ-${stamp}`, direction: 'return',
        items: [{ name: 'Лимонад', sku: 'PB-A', declaredQty: 10 }],
      },
    });
    await api('POST', '/api/returns', {
      token: workerToken,
      body: { invoiceItemId: ret.body.items[0].id, qty: 6, qualityBucket: 'packaging_defect', cellBlockId: c3.id },
    });

    const outForPack = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: companyA.body.id, number: `ЗАК-PACK-${stamp}`, direction: 'out',
        items: [{ name: 'Лимонад', sku: 'PB-A', declaredQty: 6 }],
      },
    });
    const beforeRepack = await api('GET', `/api/shipping/suggest/${outForPack.body.items[0].id}`, { token: workerToken });
    check('до перепаковки товар клиенту недоступен', () => {
      assert.equal(beforeRepack.body.totalAvailable, 0, JSON.stringify(beforeRepack.body.cells));
      assert.equal(beforeRepack.body.shortfall, 6);
    });

    const repack = await api('POST', '/api/cells/move', {
      token: workerToken,
      body: {
        sku: 'PB-A', companyId: companyA.body.id, fromCellBlockId: c3.id,
        qty: 6, fromQuality: 'packaging_defect', toQuality: 'good',
      },
    });
    check('перепаковку можно записать', () => {
      assert.equal(repack.status, 201, JSON.stringify(repack.body));
      assert.equal(repack.body.toQuality, 'good');
    });

    const afterRepack = await api('GET', `/api/shipping/suggest/${outForPack.body.items[0].id}`, { token: workerToken });
    check('после перепаковки товар вернулся в продажу', () => {
      assert.equal(afterRepack.body.totalAvailable, 6, JSON.stringify(afterRepack.body.cells));
      assert.equal(afterRepack.body.shortfall, 0);
    });

    const tooMuch = await api('POST', '/api/cells/move', {
      token: workerToken,
      body: {
        sku: 'PB-A', companyId: companyA.body.id, fromCellBlockId: c3.id,
        qty: 99, fromQuality: 'good', toCellBlockId: c1.id,
      },
    });
    check('больше, чем лежит, переместить нельзя', () => {
      assert.equal(tooMuch.status, 409, JSON.stringify(tooMuch.body));
    });

    const nowhere = await api('POST', '/api/cells/move', {
      token: workerToken,
      body: {
        sku: 'PB-A', companyId: companyA.body.id, fromCellBlockId: c3.id,
        qty: 1, fromQuality: 'good',
      },
    });
    check('перемещение никуда и ни во что отклоняется', () => {
      assert.equal(nowhere.status, 400, JSON.stringify(nowhere.body));
    });

    // ---------- Перестановка между ячейками: товар не теряется ----------
    const movedCell = await api('POST', '/api/cells/move', {
      token: workerToken,
      body: {
        sku: 'PB-A', companyId: companyA.body.id, fromCellBlockId: c3.id,
        toCellBlockId: c2.id, qty: 2, fromQuality: 'good',
      },
    });
    check('часть товара переставили в другую ячейку', () => {
      assert.equal(movedCell.status, 201, JSON.stringify(movedCell.body));
    });

    const afterMove = await api('GET', `/api/shipping/suggest/${outForPack.body.items[0].id}`, { token: workerToken });
    check('итог не изменился — товар переехал, а не размножился', () => {
      assert.equal(afterMove.body.totalAvailable, 6, JSON.stringify(afterMove.body.cells));
      assert.equal(afterMove.body.cells.length, 2, 'теперь он в двух ячейках');
    });

    // Остаток той же возвратной строки — настоящий брак, в ту же ячейку:
    // теперь на полке лежит и годное (перепакованное), и брак.
    await api('POST', '/api/returns', {
      token: workerToken,
      body: { invoiceItemId: ret.body.items[0].id, qty: 4, qualityBucket: 'defective', cellBlockId: c3.id },
    });

    // Брак на полке виден отдельно от годного — иначе «сколько можно
    // отгрузить» включало бы товар, который клиенту не уедет.
    const { withTenantContext } = require('../src/db/pool');
    const kladovshchik = require('../src/agents/kladovshchik');
    const whId = JSON.parse(Buffer.from(ownerToken.split('.')[1], 'base64').toString('utf8')).warehouseId;
    const found = await withTenantContext({ warehouseId: whId }, (c) => (
      kladovshchik.findProducts(c, whId, 'PB-A')
    ));
    check('поиск отличает годное от брака на той же полке', () => {
      const it = found[0];
      assert.ok(it, 'товар не найден');
      assert.equal(it.totalQty, 10, '6 перепакованных + 4 остались браком');
      assert.equal(it.availableQty, 6, 'отгрузить можно только годное');
      assert.equal(it.notForSaleQty, 4);
      assert.ok(it.locations.some((l) => l.state === 'брак'), JSON.stringify(it.locations));
      assert.ok(it.locations.some((l) => l.state === 'годный'), 'годное тоже должно быть видно');
    });

    // ---------- Лист грузчика ----------
    await receive(companyA.body.id, 'PB-B', 'Мармелад', 40, c1.id, `ПРХ-B-${stamp}`);
    await receive(companyB.body.id, 'PB-B', 'Мармелад', 15, c2.id, `ПРХ-B2-${stamp}`);

    const o1 = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: companyA.body.id, number: `ЗАК-1-${stamp}`, direction: 'out',
        items: [{ name: 'Мармелад', sku: 'PB-B', declaredQty: 10 }],
      },
    });
    const o2 = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: companyA.body.id, number: `ЗАК-2-${stamp}`, direction: 'out',
        items: [{ name: 'Мармелад', sku: 'PB-B', declaredQty: 25 }],
      },
    });
    const o3 = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: companyB.body.id, number: `ЗАК-3-${stamp}`, direction: 'out',
        items: [{ name: 'Мармелад', sku: 'PB-B', declaredQty: 50 }],
      },
    });

    const list = await api('GET', '/api/shipping/pick-list', { token: workerToken });
    check('лист собрал все незакрытые заказы', () => {
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const numbers = list.body.orders.map((o) => o.number);
      assert.ok(numbers.includes(o1.body.number), JSON.stringify(numbers));
      assert.ok(numbers.includes(o3.body.number));
    });

    const lineA = list.body.lines.find((l) => l.sku === 'PB-B' && l.needQty === 35);
    check('один товар одной компании из двух заказов сложился в строку', () => {
      assert.ok(lineA, JSON.stringify(list.body.lines.map((l) => ({ sku: l.sku, need: l.needQty }))));
      assert.equal(lineA.needQty, 35, '10 + 25');
      assert.equal(lineA.perOrder.length, 2, 'но видно, сколько чьё');
      assert.deepEqual(lineA.perOrder.map((p) => p.qty).sort((a, b) => a - b), [10, 25]);
    });

    check('товар разных компаний в одну строку не смешался', () => {
      const lineB = list.body.lines.find((l) => l.sku === 'PB-B' && l.needQty === 50);
      assert.ok(lineB, 'заказ второй компании должен быть отдельной строкой');
      assert.equal(lineB.perOrder.length, 1);
    });

    check('по строке расписано, из какой ячейки сколько брать', () => {
      const take = lineA.cells.reduce((sum, c) => sum + c.take, 0);
      assert.equal(take, 35, JSON.stringify(lineA.cells));
      assert.ok(lineA.cells.every((c) => c.take <= c.available), 'нельзя брать больше, чем в ячейке');
      assert.equal(lineA.shortfall, 0);
    });

    check('нехватку по чужому заказу видно до похода к стеллажу', () => {
      const lineB = list.body.lines.find((l) => l.sku === 'PB-B' && l.needQty === 50);
      assert.equal(lineB.shortfall, 35, 'на полке 15, просят 50');
    });

    // Отобрали часть — лист должен об этом знать.
    await api('POST', '/api/shipping', {
      token: workerToken,
      body: {
        invoiceItemId: o1.body.items[0].id, pickedQty: 10,
        cellBlockId: lineA.cells[0].cellBlockId, isFinal: true,
      },
    });
    const list2 = await api('GET', '/api/shipping/pick-list', { token: workerToken });
    check('закрытая позиция уходит из листа, остальное пересчитывается', () => {
      const again = list2.body.lines.find((l) => l.sku === 'PB-B' && l.perOrder.some((p) => p.invoiceNumber === o2.body.number));
      assert.ok(again, JSON.stringify(list2.body.lines.map((l) => l.needQty)));
      assert.equal(again.needQty, 25, 'осталась только вторая заявка');
      assert.ok(!again.perOrder.some((p) => p.invoiceNumber === o1.body.number), 'закрытый заказ не должен висеть в листе');
    });

    const filtered = await api('GET', `/api/shipping/pick-list?invoiceIds=${o3.body.id}`, { token: workerToken });
    check('лист можно собрать по выбранным заказам', () => {
      assert.equal(filtered.body.orders.length, 1);
      assert.equal(filtered.body.orders[0].number, o3.body.number);
    });

    const bad = await api('GET', '/api/shipping/pick-list?invoiceIds=не-uuid', { token: workerToken });
    check('мусор в списке заказов отклоняется', () => {
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
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
