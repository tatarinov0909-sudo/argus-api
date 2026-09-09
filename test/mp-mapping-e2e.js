// Сопоставление артикулов площадки с номенклатурой склада.
//
// Из-за отсутствия этого экрана 36 заказов уехали в поставку несобираемыми,
// а 17 самых старых висели в очереди без единого способа их починить.
// Здесь проверяется главное: сопоставление лечит уже лежащие заказы, а не
// только будущие, и не может связать заказ с товаром, которого нет.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/mp-mapping-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');

const PORT = 3992;
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
      body: { name: 'Map', email: `map${stamp}@test.local`, password: 'secret123',
              warehouseName: 'Map WH', city: 'Moscow' },
    });
    const token = reg.body.token;
    const warehouseId = whIdOf(token);
    const co = await api('POST', '/api/sellers/companies', { token, body: { name: 'Слим Тим' } });
    const companyId = co.body.id;

    await api('POST', '/api/products', {
      token, body: { companyId, sku: 'PB-777', name: 'Пастила яблочная' },
    });

    // Два несопоставленных заказа: у одного артикул площадки сохранён,
    // у второго нет — он «старый», заведён до того, как мы стали хранить
    // поля площадки, и артикул лежит в нашем же поле sku.
    const mkOrder = async (number, sku, article, rid) => {
      const inv = await api('POST', '/api/invoices', {
        token,
        body: { companyId, number, direction: 'out',
                items: [{ name: 'Не сопоставлен с номенклатурой', sku, declaredQty: 1 }] },
      });
      await withTenantContext({ warehouseId }, (c) => c.query(
        `UPDATE invoices SET source = 'wb' WHERE id = $1`, [inv.body.id]));
      await withTenantContext({ warehouseId }, (c) => c.query(
        `UPDATE invoice_items SET mp_rid = $2, mp_article = $3 WHERE invoice_id = $1`,
        [inv.body.id, rid, article]));
      return inv.body.id;
    };
    const fresh = await mkOrder(`WB-N1-${stamp}`, '1201010228', '1201010228', 'rid-1');
    const old = await mkOrder(`WB-N2-${stamp}`, '1201010228', null, 'rid-2');

    // ---------- Что ждёт сопоставления ----------
    const todo = await api('GET', '/api/marketplaces/mapping/unresolved', { token });
    check('очередь на сопоставление собирается из живых заказов', () => {
      assert.equal(todo.status, 200, JSON.stringify(todo.body));
      const row = todo.body.find((x) => x.article === '1201010228');
      assert.ok(row, JSON.stringify(todo.body));
      assert.equal(row.orders, 2, 'старый заказ без сохранённого артикула не попал в очередь');
      assert.equal(row.companyName, 'Слим Тим');
    });

    // ---------- Поиск по номенклатуре ----------
    const found = await api('GET',
      `/api/marketplaces/mapping/products?companyId=${companyId}&q=пастила`, { token });
    check('товар ищется по имени, а не выгружается весь', () => {
      assert.equal(found.status, 200, JSON.stringify(found.body));
      assert.equal(found.body.length, 1, JSON.stringify(found.body));
      assert.equal(found.body[0].sku, 'PB-777');
    });
    const short = await api('GET',
      `/api/marketplaces/mapping/products?companyId=${companyId}&q=п`, { token });
    check('на одну букву поиск не отвечает — это была бы вся номенклатура', () => {
      assert.deepEqual(short.body, []);
    });

    // ---------- Нельзя связать с тем, чего нет ----------
    const ghost = await api('POST', '/api/marketplaces/mapping', {
      token, body: { companyId, sku: 'НЕТ-ТАКОГО', mpArticle: '1201010228' },
    });
    check('сопоставление с товаром, которого нет в номенклатуре, отклоняется', () => {
      assert.equal(ghost.status, 404, JSON.stringify(ghost.body));
      assert.ok(String(ghost.body.error).includes('нет в номенклатуре'), ghost.body.error);
    });
    const empty = await api('POST', '/api/marketplaces/mapping', {
      token, body: { companyId, sku: 'PB-777' },
    });
    check('без единого ключа площадки сопоставление бессмысленно и не принимается', () => {
      assert.equal(empty.status, 400, JSON.stringify(empty.body));
    });

    // ---------- Сопоставили — и очередь починилась ----------
    const saved = await api('POST', '/api/marketplaces/mapping', {
      token, body: { companyId, sku: 'PB-777', mpArticle: '1201010228', mpSku: '111222' },
    });
    check('сопоставление сохраняется и сразу лечит лежащие заказы', () => {
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      // Оба: и тот, у которого артикул сохранён, и «старый» — по нашему полю.
      assert.equal(saved.body.fixedOrders, 2, JSON.stringify(saved.body));
    });

    const nowReady = await api('GET', `/api/supplies/pending/${companyId}`, { token });
    check('и оба заказа стали собираемыми', () => {
      const rows = nowReady.body.filter((o) => o.id === fresh || o.id === old);
      assert.equal(rows.length, 2, JSON.stringify(nowReady.body));
      for (const r of rows) {
        assert.equal(r.ready, true, JSON.stringify(r));
        assert.equal(r.sku, 'PB-777', JSON.stringify(r));
      }
    });
    const cleared = await api('GET', '/api/marketplaces/mapping/unresolved', { token });
    check('очередь на сопоставление опустела', () => {
      assert.deepEqual(cleared.body, [], JSON.stringify(cleared.body));
    });
    const inSupply = await api('POST', '/api/supplies', {
      token, body: { invoiceIds: [fresh, old] },
    });
    check('теперь эти заказы принимаются в поставку', () => {
      assert.equal(inSupply.status, 201, JSON.stringify(inSupply.body));
    });

    // ---------- Один артикул площадки — один наш товар ----------
    await api('POST', '/api/products', {
      token, body: { companyId, sku: 'PB-888', name: 'Пастила грушевая' },
    });
    await api('POST', '/api/marketplaces/mapping', {
      token, body: { companyId, sku: 'PB-888', mpArticle: '1201010228' },
    });
    const rows = await api('GET', `/api/marketplaces/mapping?companyId=${companyId}`, { token });
    check('повторное сопоставление заменяет прежнее, а не ложится рядом', () => {
      const same = rows.body.filter((x) => x.mpArticle === '1201010228');
      assert.equal(same.length, 1, JSON.stringify(rows.body));
      assert.equal(same[0].sku, 'PB-888');
    });
    check('в списке видно имя товара — иначе строка это два кода без смысла', () => {
      const one = rows.body.find((x) => x.sku === 'PB-888');
      assert.equal(one.productName, 'Пастила грушевая');
      assert.equal(one.orphan, false);
    });

    // ---------- Ловушка с порядком маршрутов ----------
    //
    // У `DELETE /mapping/<id>` и `DELETE /<companyId>/<marketplace>` одинаковое
    // число сегментов. Объяви сопоставление ниже — и удаление строки снимало бы
    // ключ площадки у компании с идентификатором «mapping». Проверяем, что
    // удаляется именно строка сопоставления.
    const target = rows.body.find((x) => x.sku === 'PB-888');
    const del = await api('DELETE', `/api/marketplaces/mapping/${target.id}`, { token });
    check('строка сопоставления удаляется своим маршрутом, а не маршрутом ключей', () => {
      assert.equal(del.status, 200, JSON.stringify(del.body));
      assert.equal(del.body.removed, 1);
    });
    const after = await api('GET', `/api/marketplaces/mapping?companyId=${companyId}`, { token });
    check('и её больше нет', () => {
      assert.ok(!after.body.some((x) => x.id === target.id), JSON.stringify(after.body));
    });
    const missing = await api('DELETE',
      '/api/marketplaces/mapping/00000000-0000-0000-0000-000000000000', { token });
    check('удаление несуществующей строки — понятный отказ, а не молчание', () => {
      assert.equal(missing.status, 404, JSON.stringify(missing.body));
    });

    // ---------- Работнику здесь делать нечего ----------
    const key = await api('POST', '/api/staff', { token, body: { name: 'Грузчик' } });
    const workerToken = (await api('POST', '/api/auth/staff/login',
      { body: { keyCode: key.body.key_code } })).body.token;
    const denied = await api('GET', '/api/marketplaces/mapping/unresolved', { token: workerToken });
    check('работник к сопоставлению не допущен — он не решает, что чем является', () => {
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
    });
  } finally { server.close(); }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
