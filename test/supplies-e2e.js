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

    const ready = await api('POST', `/api/supplies/${supplyId}/ready`, { token: ownerToken });
    check('собрана — со временем', () => {
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
  } finally { server.close(); }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
