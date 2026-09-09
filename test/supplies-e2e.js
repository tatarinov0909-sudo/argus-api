// Поставка — пачка заказов, уезжающая одной машиной.
//
// Проверяется не «создалась ли запись», а то, из-за чего поставка вообще
// появилась: заказы надо собрать в пачку, напечатать по ней два РАЗНЫХ
// документа и зафиксировать отгрузку так, чтобы её нельзя было отменить
// задним числом.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/supplies-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');

const PORT = 3989;
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
      body: { name: 'Supply', email: `sup${stamp}@test.local`, password: 'secret123',
              warehouseName: 'Sup WH', city: 'Moscow' },
    });
    const ownerToken = reg.body.token;
    const warehouseId = whIdOf(ownerToken);

    const alpha = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Альфа' } });
    const beta = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Бета' } });

    // Номенклатура склада. Раньше тест её не заводил, и заказы ссылались на
    // артикулы, которых на складе не существует. Проверка «можно ли это
    // собрать» на таких данных проходила при любом ответе — именно поэтому
    // в живую поставку и уехали 36 несобираемых заказов.
    for (const companyId of [alpha.body.id, beta.body.id]) {
      for (const [sku, name] of [['PB-A', 'Renal для кошек 2кг'], ['PB-B', 'Сухой корм Ageing 12+']]) {
        await api('POST', '/api/products', {
          token: ownerToken, body: { companyId, sku, name },
        });
      }
    }

    const mkOrder = async (companyId, number, sku, name, qty) => {
      const inv = await api('POST', '/api/invoices', {
        token: ownerToken,
        body: { companyId, number, direction: 'out', items: [{ name, sku, declaredQty: qty }] },
      });
      return inv.body.id;
    };

    // Три заказа одного продавца: два на один товар, один на другой.
    // Ради этого случая и нужны два разных документа.
    const o1 = await mkOrder(alpha.body.id, `WB-A1-${stamp}`, 'PB-A', 'Renal для кошек 2кг', 1);
    const o2 = await mkOrder(alpha.body.id, `WB-A2-${stamp}`, 'PB-A', 'Renal для кошек 2кг', 1);
    const o3 = await mkOrder(alpha.body.id, `WB-A3-${stamp}`, 'PB-B', 'Сухой корм Ageing 12+', 5);
    const foreign = await mkOrder(beta.body.id, `WB-B1-${stamp}`, 'PB-A', 'Renal для кошек 2кг', 1);

    // Номера отправлений — из них печатается упаковочный лист.
    await withTenantContext({ warehouseId }, (c) => c.query(
      `UPDATE invoice_items SET mp_rid = 'rid-' || sku || '-' || substr(md5(random()::text), 1, 6),
              mp_article = 'ART-' || sku, mp_barcode = '20000000' || length(sku)::text,
              mp_nm_id = '111222'
        WHERE warehouse_id = $1`, [warehouseId]));

    // ---------- Экран менеджера: у кого накопилось ----------
    const pending = await api('GET', '/api/supplies/pending', { token: ownerToken });
    check('менеджер видит продавцов с числом накопившихся заказов', () => {
      assert.equal(pending.status, 200, JSON.stringify(pending.body));
      const a = pending.body.find((x) => x.companyName === 'Альфа');
      const b = pending.body.find((x) => x.companyName === 'Бета');
      assert.equal(a.orders, 3, JSON.stringify(a));
      assert.equal(a.units, 7, 'штук: 1 + 1 + 5');
      assert.equal(b.orders, 1);
    });
    check('первым идёт тот, у кого больше — по нему и решают, чем заняться', () => {
      assert.equal(pending.body[0].companyName, 'Альфа');
    });
    check('«pending» не принимается за номер поставки', () => {
      assert.ok(Array.isArray(pending.body), JSON.stringify(pending.body).slice(0, 80));
    });

    const alphaOrders = await api('GET', `/api/supplies/pending/${alpha.body.id}`, { token: ownerToken });
    check('заказы выбранного продавца — с артикулом площадки и признаком готовности', () => {
      assert.equal(alphaOrders.status, 200, JSON.stringify(alphaOrders.body));
      assert.equal(alphaOrders.body.length, 3);
      assert.ok(alphaOrders.body.every((o) => o.ready), 'заказ без артикула или отправления не собрать');
      assert.ok(alphaOrders.body[0].article, 'нет артикула площадки');
    });

    // ---------- Смешивать продавцов нельзя ----------
    const mixed = await api('POST', '/api/supplies', {
      token: ownerToken, body: { invoiceIds: [o1, foreign] },
    });
    check('в одну поставку нельзя положить заказы двух продавцов', () => {
      assert.equal(mixed.status, 400, JSON.stringify(mixed.body));
      assert.ok(String(mixed.body.error).includes('одного продавца'), mixed.body.error);
    });

    // ---------- Приход в поставку не положить ----------
    const inbound = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: { companyId: alpha.body.id, number: `ПРХ-${stamp}`, direction: 'in',
              items: [{ name: 'Renal', sku: 'PB-A', declaredQty: 10 }] },
    });
    const wrongDir = await api('POST', '/api/supplies', {
      token: ownerToken, body: { invoiceIds: [inbound.body.id] },
    });
    check('приёмку в поставку не отправить — это не заказ на отгрузку', () => {
      assert.equal(wrongDir.status, 400, JSON.stringify(wrongDir.body));
    });

    // ---------- Собрали ----------
    const created = await api('POST', '/api/supplies', {
      token: ownerToken,
      body: { invoiceIds: [o1, o2, o3], marketplace: 'wb', destination: 'СЦ Подольск' },
    });
    check('поставка собирается из заказов одного продавца', () => {
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.orders, 3);
      assert.ok(/^ПС-\d{4}-\d{2}$/.test(created.body.number), created.body.number);
    });
    const supplyId = created.body.id;

    const twice = await api('POST', '/api/supplies', {
      token: ownerToken, body: { invoiceIds: [o1] },
    });
    check('один заказ в две поставки не положить — иначе обещали коробку двум машинам', () => {
      assert.equal(twice.status, 409, JSON.stringify(twice.body));
    });

    // ---------- Два разных документа ----------
    const c = await api('GET', `/api/supplies/${supplyId}`, { token: ownerToken });
    check('сводка: заказов, штук, уникальных артикулов', () => {
      assert.equal(c.status, 200, JSON.stringify(c.body));
      assert.equal(c.body.totals.orders, 3);
      assert.equal(c.body.totals.units, 7, 'штук: 1 + 1 + 5');
      assert.equal(c.body.totals.uniqueSkus, 2);
    });
    check('лист комплектации складывает одинаковые артикулы', () => {
      const renal = c.body.picking.find((l) => l.sku === 'PB-A');
      assert.equal(c.body.picking.length, 2, JSON.stringify(c.body.picking));
      assert.equal(renal.qty, 2, 'два заказа на один товар должны сложиться');
    });
    check('упаковочный лист их НЕ складывает — у каждой посылки свой стикер', () => {
      const renalLines = c.body.packing.filter((l) => l.sku === 'PB-A');
      assert.equal(renalLines.length, 2, JSON.stringify(renalLines));
      assert.ok(renalLines[0].rid && renalLines[1].rid, 'номера отправлений потерялись');
      assert.notEqual(renalLines[0].rid, renalLines[1].rid);
    });
    check('в обоих листах есть артикул и штрихкод площадки', () => {
      assert.ok(c.body.picking[0].article, 'нет артикула');
      assert.ok(c.body.picking[0].barcode, 'нет штрихкода');
    });

    // ---------- Только вперёд ----------
    const skip = await api('POST', `/api/supplies/${supplyId}/ship`, { token: ownerToken });
    check('нельзя отгрузить то, что не отмечено собранным', () => {
      assert.equal(skip.status, 409, JSON.stringify(skip.body));
    });

    // Пока ни одна коробка не снята с полки, поставка собранной не считается.
    // Без этой охраны её можно было отгрузить, не тронув склад: заказы
    // получали «отгружено», а товар продолжал числиться в ячейке.
    const early = await api('POST', `/api/supplies/${supplyId}/ready`, { token: ownerToken });
    check('несобранную поставку нельзя объявить собранной', () => {
      assert.equal(early.status, 409, JSON.stringify(early.body));
      assert.ok(String(early.body.error).includes('Ещё не собрано'), early.body.error);
    });

    // Собираем по-настоящему: работник снимает товар с полок.
    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'Сборщик' } });
    const workerToken = (await api('POST', '/api/auth/staff/login',
      { body: { keyCode: staff.body.key_code } })).body.token;
    await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 3, tierCount: 2 }] },
    });
    const blocks = (await api('GET', '/api/cells/rows', { token: ownerToken }))
      .body.flatMap((r) => r.blocks);
    const near = blocks[0];
    const far = blocks[blocks.length - 1];
    // «Renal» стоит в дальней ячейке, «Сухой корм» — в ближней. По алфавиту
    // первым идёт Renal, по складу — Сухой. Разложить их в одну ячейку значит
    // не проверить ничего: любой порядок сойдётся.
    await withTenantContext({ warehouseId }, (c) => c.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality)
       VALUES ($1, $3, $4, 'PB-A', 50, 'good'), ($2, $3, $4, 'PB-B', 50, 'good'),
              ($1, $3, $4, 'PB-B', 7, 'defective')`,
      [far.id, near.id, warehouseId, alpha.body.id]));

    const sheet = await api('GET', `/api/supplies/${supplyId}`, { token: ownerToken });
    check('лист комплектации ведёт по складу, а не по алфавиту', () => {
      const order = sheet.body.picking.map((r) => r.sku);
      assert.deepEqual(order, ['PB-B', 'PB-A'],
        'по алфавиту вышло бы PB-A, PB-B — и кладовщик прошёл бы ряд дважды: ' + JSON.stringify(order));
    });
    check('в листе написано, из какой ячейки брать и сколько там есть', () => {
      const a = sheet.body.picking.find((r) => r.sku === 'PB-A');
      assert.equal(a.cells.length, 1, JSON.stringify(a.cells));
      assert.ok(a.cells[0].label, 'у ячейки нет адреса');
      assert.equal(a.available, 50);
    });
    check('брак в лист не попадает — его нельзя отгрузить клиенту', () => {
      const b = sheet.body.picking.find((r) => r.sku === 'PB-B');
      assert.equal(b.available, 50, 'семь бракованных попали в доступное к отбору');
      assert.equal(b.cells.length, 1, JSON.stringify(b.cells));
    });

    for (const orderId of [o1, o2, o3]) {
      const full = await api('GET', `/api/invoices/${orderId}`, { token: ownerToken });
      const item = full.body.items[0];
      const from = item.sku === 'PB-A' ? far : near;
      const picked = await api('POST', '/api/shipping', {
        token: workerToken,
        body: { invoiceItemId: item.id, pickedQty: Number(item.declared_qty), cellBlockId: from.id },
      });
      assert.equal(picked.status, 201, JSON.stringify(picked.body));
    }

    const ready = await api('POST', `/api/supplies/${supplyId}/ready`, { token: ownerToken });
    check('после сборки всех заказов — собрана, со временем', () => {
      assert.equal(ready.status, 200, JSON.stringify(ready.body));
      assert.ok(ready.body.ready_at);
    });

    const shipped = await api('POST', `/api/supplies/${supplyId}/ship`, {
      token: ownerToken, body: { destination: 'СЦ Подольск' },
    });
    check('уехала — со временем и с точкой назначения', () => {
      assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
      assert.ok(shipped.body.shipped_at);
      assert.equal(shipped.body.destination, 'СЦ Подольск');
    });

    const back = await api('POST', `/api/supplies/${supplyId}/ready`, { token: ownerToken });
    check('уехавшую назад не вернуть — машина ушла, и база не должна врать', () => {
      assert.equal(back.status, 409, JSON.stringify(back.body));
      assert.ok(String(back.body.error).includes('уехала'), back.body.error);
    });

    const orders = await api('GET', '/api/invoices?direction=out', { token: ownerToken });
    check('заказы поставки тоже стали отгруженными', () => {
      const mine = orders.body.filter((i) => [o1, o2, o3].includes(i.id));
      assert.equal(mine.length, 3);
      assert.ok(mine.every((i) => i.status === 'shipped'), JSON.stringify(mine.map((i) => i.status)));
    });

    // ---------- Продавец видит своё и только своё ----------
    const key = await api('POST', `/api/sellers/companies/${alpha.body.id}/keys`, { token: ownerToken });
    const sellerToken = (await api('POST', '/api/auth/seller/login', {
      body: { keyCode: key.body.key_code, name: 'Альфа' },
    })).body.token;
    const afterSupply = await api('GET', '/api/supplies/pending', { token: ownerToken });
    check('заказы, ушедшие в поставку, из списка накопившегося исчезают', () => {
      const a = afterSupply.body.find((x) => x.companyName === 'Альфа');
      assert.ok(!a, JSON.stringify(afterSupply.body));
    });

    const badFilter = await api('GET', '/api/supplies?status=foo', { token: ownerToken });
    check('неизвестный статус в фильтре — понятный отказ, а не внутренняя ошибка', () => {
      assert.equal(badFilter.status, 400, JSON.stringify(badFilter.body));
    });

    const seen = await api('GET', '/api/supplies', { token: sellerToken });
    check('продавец видит свою поставку — это его товар уехал', () => {
      assert.equal(seen.status, 200, JSON.stringify(seen.body));
      assert.equal(seen.body.length, 1, JSON.stringify(seen.body));
      assert.equal(seen.body[0].number, created.body.number);
    });

    const betaKey = await api('POST', `/api/sellers/companies/${beta.body.id}/keys`, { token: ownerToken });
    const betaToken = (await api('POST', '/api/auth/seller/login', {
      body: { keyCode: betaKey.body.key_code, name: 'Бета' },
    })).body.token;
    const foreignSeen = await api('GET', '/api/supplies', { token: betaToken });
    check('и не видит чужую', () => {
      assert.equal(foreignSeen.body.length, 0, JSON.stringify(foreignSeen.body));
    });
    // ---------- Несобираемый заказ в поставку не попадает ----------
    //
    // Главная проверка этого файла. Артикул есть, номер отправления есть,
    // а товара такого на складе нет — собрать нечего. Раньше «готов»
    // означало «строка с артикулом не пустая», а она не пуста никогда:
    // у несопоставленного заказа туда кладётся артикул площадки.
    const ghostOrder = await mkOrder(alpha.body.id, `WB-GHOST-${stamp}`, 'НЕТ-ТАКОГО', 'Товар с площадки', 1);
    await withTenantContext({ warehouseId }, (c) => c.query(
      `UPDATE invoices SET source = 'wb' WHERE id = $1`, [ghostOrder]));
    await withTenantContext({ warehouseId }, (c) => c.query(
      `UPDATE invoice_items SET mp_rid = 'rid-ghost', mp_article = 'ART-GHOST'
        WHERE invoice_id = $1`, [ghostOrder]));

    const withGhost = await api('GET', `/api/supplies/pending/${alpha.body.id}`, { token: ownerToken });
    check('заказ на товар, которого нет в номенклатуре, не считается готовым', () => {
      const g = withGhost.body.find((o) => o.id === ghostOrder);
      assert.ok(g, 'заказ исчез из очереди');
      assert.equal(g.ready, false, JSON.stringify(g));
    });

    const refused = await api('POST', '/api/supplies', {
      token: ownerToken, body: { invoiceIds: [ghostOrder] },
    });
    check('и сервер сам отказывается брать его в поставку, а не надеется на экран', () => {
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.ok(String(refused.body.error).includes('нельзя собрать'), refused.body.error);
    });

    // ---------- Разобрать поставку ----------
    const spare = await mkOrder(alpha.body.id, `WB-A4-${stamp}`, 'PB-B', 'Сухой корм Ageing 12+', 2);
    await withTenantContext({ warehouseId }, (c) => c.query(
      `UPDATE invoice_items SET mp_rid = 'rid-spare' WHERE invoice_id = $1`, [spare]));
    const toDisband = await api('POST', '/api/supplies', {
      token: ownerToken, body: { invoiceIds: [spare] },
    });
    check('поставка для разбора собралась', () => {
      assert.equal(toDisband.status, 201, JSON.stringify(toDisband.body));
    });
    const undone = await api('DELETE', `/api/supplies/${toDisband.body.id}`, { token: ownerToken });
    check('пока поставка собирается, её можно разобрать', () => {
      assert.equal(undone.status, 200, JSON.stringify(undone.body));
      assert.equal(undone.body.returned, 1, JSON.stringify(undone.body));
    });
    const backInQueue = await api('GET', `/api/supplies/pending/${alpha.body.id}`, { token: ownerToken });
    check('разобранные заказы вернулись в очередь', () => {
      assert.ok(backInQueue.body.some((o) => o.id === spare), 'заказ не вернулся');
    });
    const gone = await api('GET', `/api/supplies/${toDisband.body.id}`, { token: ownerToken });
    check('а самой поставки больше нет', () => {
      assert.equal(gone.status, 404, JSON.stringify(gone.body));
    });
    const shippedDisband = await api('DELETE', `/api/supplies/${supplyId}`, { token: ownerToken });
    check('уехавшую поставку разобрать нельзя — машина ушла', () => {
      assert.equal(shippedDisband.status, 409, JSON.stringify(shippedDisband.body));
    });

  } finally { server.close(); }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
