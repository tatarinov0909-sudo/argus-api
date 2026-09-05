// Наборы («сплиты»): состав, «сколько можно собрать» и сама сборка.
//
// Половина живой очереди Wildberries — наборы, поэтому цена ошибки здесь та
// же, что у перемещения: товар может исчезнуть (списали компоненты и упали) или
// размножиться (собрали больше, чем было из чего). Отдельно проверяем, что
// неудачная сборка не съедает компоненты — это самый дорогой из возможных багов.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/kits-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');

const PORT = 3987;
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

async function expectFails(run) {
  try {
    await run();
    return null;
  } catch (err) {
    return err.code || err.message;
  }
}

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Kit Owner', email: `kit${stamp}@test.local`, password: 'secret123',
        warehouseName: 'Kit WH', city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const ownerToken = reg.body.token;
    const warehouseId = whIdOf(ownerToken);

    const seller = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Слим Тим' } });
    const other = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Другой' } });
    const companyId = seller.body.id;

    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'Работник' } });
    const workerToken = (await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    })).body.token;

    await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 4, tierCount: 2 }, { rackCount: 4, tierCount: 2 }] },
    });
    const blocks = (await api('GET', '/api/cells/rows', { token: ownerToken }))
      .body.flatMap((r) => r.blocks);
    const [c1, c2, c3, c4] = blocks;

    const run = (fn) => withTenantContext({ warehouseId }, (client) => fn(client));

    async function receive(cid, sku, name, qty, cellId, num, bucket) {
      const inv = await api('POST', '/api/invoices', {
        token: ownerToken,
        body: {
          companyId: cid,
          number: num,
          direction: bucket ? 'return' : 'in',
          items: [{ name, sku, declaredQty: qty }],
        },
      });
      const res = bucket
        ? await api('POST', '/api/returns', {
          token: workerToken,
          body: {
            invoiceItemId: inv.body.items[0].id, qty, qualityBucket: bucket, cellBlockId: cellId,
          },
        })
        : await api('POST', '/api/receiving', {
          token: workerToken,
          body: { invoiceItemId: inv.body.items[0].id, acceptedQty: qty, cellBlockId: cellId },
        });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }

    const addComponent = (kit, comp, qty, cid = companyId) => run((c) => c.query(
      `INSERT INTO product_kits (warehouse_id, company_id, kit_sku, component_sku, qty)
       VALUES ($1, $2, $3, $4, $5)`,
      [warehouseId, cid, kit, comp, qty],
    ));

    // Набор «Ассорти печенья»: овсяное х2, кокосовое х1 — как в живой матрице,
    // где один и тот же компонент входит в набор дважды.
    const KIT = 'PB-KIT-1';
    await addComponent(KIT, 'PB-OAT', 2);
    await addComponent(KIT, 'PB-COCO', 1);

    // ---------- Целостность самой таблицы ----------
    const selfKit = await expectFails(() => addComponent('PB-LOOP', 'PB-LOOP', 1));
    check('набор не может состоять из самого себя', () => {
      assert.ok(selfKit, 'вставка прошла — это бесконечная рекурсия при сборке');
    });

    const dup = await expectFails(() => addComponent(KIT, 'PB-OAT', 2));
    check('повторный импорт не удваивает состав', () => {
      assert.equal(dup, '23505', `ожидалось нарушение уникальности, получено: ${dup}`);
    });

    // ---------- Состав и «сколько можно собрать» ----------
    const notKit = await api('GET', `/api/kits/${companyId}/PB-OAT`, { token: ownerToken });
    check('обычный товар набором не притворяется', () => {
      assert.equal(notKit.status, 404, JSON.stringify(notKit.body));
    });

    await receive(companyId, 'PB-OAT', 'Печенье овсяное', 9, c1.id, `ПРХ-1-${stamp}`);
    await receive(companyId, 'PB-COCO', 'Печенье кокосовое', 20, c2.id, `ПРХ-2-${stamp}`);

    const info = await api('GET', `/api/kits/${companyId}/${KIT}`, { token: workerToken });
    check('работник видит состав набора у полки', () => {
      assert.equal(info.status, 200, JSON.stringify(info.body));
      assert.equal(info.body.components.length, 2);
    });
    check('собрать можно по самому дефицитному компоненту, а не по общему счёту', () => {
      // Овсяного 9 по 2 на набор — 4 набора. Кокосового хватило бы на 20.
      assert.equal(info.body.buildable, 4, JSON.stringify(info.body));
    });
    check('названо, что именно упирается', () => {
      assert.deepEqual(info.body.limitedBy, ['PB-OAT']);
    });

    // ---------- Брак в состав не идёт ----------
    await receive(companyId, 'PB-OAT', 'Печенье овсяное', 40, c3.id, `ВЗВ-BAD-${stamp}`, 'defective');
    const withDefect = await api('GET', `/api/kits/${companyId}/${KIT}`, { token: ownerToken });
    check('бракованный компонент не увеличивает число наборов', () => {
      assert.equal(withDefect.body.buildable, 4, JSON.stringify(withDefect.body.components));
    });

    // ---------- Неудачная сборка ничего не съедает ----------
    const tooMany = await api('POST', '/api/kits/assemble', {
      token: workerToken,
      body: { companyId, kitSku: KIT, qty: 5, toCellBlockId: c4.id },
    });
    check('собрать больше, чем есть из чего, нельзя', () => {
      assert.equal(tooMany.status, 409, JSON.stringify(tooMany.body));
    });
    const afterFail = await run((c) => c.query(
      `SELECT COALESCE(SUM(qty), 0) AS qty FROM cell_stock
       WHERE warehouse_id = $1 AND sku = 'PB-COCO' AND quality = 'good'`,
      [warehouseId],
    ));
    check('после отказа компоненты остались на месте', () => {
      assert.equal(Number(afterFail.rows[0].qty), 20, 'кокосовое печенье списали впустую');
    });

    // ---------- Сборка ----------
    const built = await api('POST', '/api/kits/assemble', {
      token: workerToken,
      body: { companyId, kitSku: KIT, qty: 3, toCellBlockId: c4.id },
    });
    check('сборка проходит', () => {
      assert.equal(built.status, 201, JSON.stringify(built.body));
      assert.equal(built.body.qty, 3);
    });

    const after = await run((c) => c.query(
      `SELECT sku, COALESCE(SUM(qty), 0) AS qty FROM cell_stock
       WHERE warehouse_id = $1 AND quality = 'good' AND sku IN ('PB-OAT', 'PB-COCO', $2)
       GROUP BY sku`,
      [warehouseId, KIT],
    ));
    const qtyOf = (sku) => Number((after.rows.find((r) => r.sku === sku) || { qty: 0 }).qty);
    check('компоненты списаны ровно по составу', () => {
      assert.equal(qtyOf('PB-OAT'), 9 - 3 * 2, 'овсяного списали не 6');
      assert.equal(qtyOf('PB-COCO'), 20 - 3, 'кокосового списали не 3');
    });
    check('наборы легли в ячейку', () => {
      assert.equal(qtyOf(KIT), 3);
    });
    const kitCell = await run((c) => c.query(
      `SELECT cell_block_id FROM cell_stock WHERE warehouse_id = $1 AND sku = $2`,
      [warehouseId, KIT],
    ));
    check('именно в ту ячейку, которую назвали', () => {
      assert.equal(kitCell.rows[0].cell_block_id, c4.id);
    });

    // ---------- След операции ----------
    // Сборка двигает остаток и не привязана ни к какой накладной. Без записи
    // «кто и когда» спор о недостаче упирается в ничто.
    const trail = await run((c) => c.query(
      `SELECT kind, sku, qty, to_cell_block_id, details, worker_key_id
       FROM stock_operations WHERE warehouse_id = $1 AND kind = 'kit_assemble'`,
      [warehouseId],
    ));
    check('сборка оставляет след: что, сколько и куда', () => {
      assert.equal(trail.rows.length, 1, 'операция не записана');
      assert.equal(trail.rows[0].sku, KIT);
      assert.equal(Number(trail.rows[0].qty), 3);
      assert.equal(trail.rows[0].to_cell_block_id, c4.id);
    });
    check('и главное — кто её сделал', () => {
      assert.ok(trail.rows[0].worker_key_id, 'работник не записан');
    });
    check('в следе виден и состав, который разобрали', () => {
      const comps = trail.rows[0].details.components || [];
      assert.equal(comps.length, 2, JSON.stringify(trail.rows[0].details));
      const oat = comps.find((x) => x.sku === 'PB-OAT');
      assert.equal(oat.taken, 6, 'списанное количество в следе не сходится');
    });
    check('неудачная сборка следа не оставляет', () => {
      // Та, что упала на нехватке компонентов, выше по тесту.
      assert.equal(trail.rows.length, 1, 'записана операция, которой не было');
    });

    // 1С должна узнать и о сборке: компонентов стало меньше, набора больше.
    const kitOutbox = await run((c) => c.query(
      `SELECT payload FROM sync_outbox
       WHERE warehouse_id = $1 AND event_type = 'kit_assembled'`,
      [warehouseId],
    ));
    check('сборка уходит в очередь для 1С', () => {
      assert.equal(kitOutbox.rows.length, 1, 'события сборки в очереди нет');
    });
    check('и в нём обе стороны движения: набор в плюс, компоненты в минус', () => {
      const lines = kitOutbox.rows[0].payload.lines;
      const kit = lines.find((l) => l.sku === KIT);
      const oat = lines.find((l) => l.sku === 'PB-OAT');
      assert.equal(kit.deltaQty, 3, JSON.stringify(lines));
      assert.equal(oat.deltaQty, -6, JSON.stringify(lines));
    });

    const afterBuild = await api('GET', `/api/kits/${companyId}/${KIT}`, { token: ownerToken });
    check('после сборки собрать можно меньше — компоненты кончаются', () => {
      assert.equal(afterBuild.body.buildable, 1, JSON.stringify(afterBuild.body.components));
    });

    // ---------- Лист сборки понимает, что нехватка закрывается сборкой ----------
    const order = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId,
        number: `ЗАК-KIT-${stamp}`,
        direction: 'out',
        items: [{ name: 'Ассорти печенья', sku: KIT, declaredQty: 4 }],
      },
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const list = await api('GET', '/api/shipping/pick-list', { token: workerToken });
    const kitLine = (list.body.lines || []).find((l) => l.sku === KIT);
    check('в листе сборки у набора видна нехватка', () => {
      assert.ok(kitLine, JSON.stringify(list.body));
      assert.equal(kitLine.shortfall, 1, 'на полке 3 из 4');
    });
    check('и сказано, что её можно закрыть сборкой', () => {
      assert.ok(kitLine.kit, 'поле kit пустое — работник пойдёт искать несуществующее');
      assert.equal(kitLine.kit.canBuild, 1);
      assert.equal(kitLine.kit.stillShort, 0);
    });

    // ---------- Обычный товар лишнего поля не получает ----------
    const plainOrder = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId,
        number: `ЗАК-PLAIN-${stamp}`,
        direction: 'out',
        items: [{ name: 'Печенье овсяное', sku: 'PB-OAT', declaredQty: 999 }],
      },
    });
    assert.equal(plainOrder.status, 201, JSON.stringify(plainOrder.body));
    const list2 = await api('GET', '/api/shipping/pick-list', { token: workerToken });
    const plainLine = (list2.body.lines || []).find((l) => l.sku === 'PB-OAT');
    check('у обычного товара нехватка остаётся нехваткой', () => {
      assert.ok(plainLine, JSON.stringify(list2.body));
      assert.ok(plainLine.shortfall > 0);
      assert.equal(plainLine.kit, undefined, 'обычному товару приписали состав');
    });

    // ---------- Состав принадлежит продавцу, а не коду ----------
    const foreign = await api('GET', `/api/kits/${other.body.id}/${KIT}`, { token: ownerToken });
    check('набор одного продавца не виден у другого', () => {
      assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    });

    // ---------- Кладовщик отвечает о наборе двумя числами ----------
    const found = await api('GET', `/api/agents/kladovshchik/find?q=${KIT}`, { token: ownerToken });
    const rows = found.body.results || found.body || [];
    const card = Array.isArray(rows) ? rows.find((r) => r.sku === KIT) : null;
    check('Кладовщик знает, сколько наборов ещё можно собрать', () => {
      assert.ok(card, JSON.stringify(found.body).slice(0, 200));
      assert.equal(card.availableQty, 3, 'готовых на полке');
      assert.ok(card.kit, 'поля kit нет — агент скажет «есть 3» и промолчит про сборку');
      assert.equal(card.kit.buildable, 1);
    });

    // ---------- Несуществующая ячейка ----------
    const badCell = await api('POST', '/api/kits/assemble', {
      token: workerToken,
      body: {
        companyId, kitSku: KIT, qty: 1, toCellBlockId: '00000000-0000-0000-0000-000000000000',
      },
    });
    check('несуществующая ячейка отклоняется', () => {
      assert.equal(badCell.status, 404, JSON.stringify(badCell.body));
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
