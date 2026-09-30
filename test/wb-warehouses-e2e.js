// Склады продавца на WB (владелец 30.09.2026): Аргус берёт в работу только
// заказы складов, отмеченных нашими; заказы чужих складов лежат отдельно и
// возвращаются, если склад отметят. Всё — только чтение WB.
//
// WB подменяется функциями модуля wb.js; настоящая сеть закрыта: любой fetch
// в тесте — ошибка.

process.env.MARKETPLACE_KEY_SECRET = process.env.MARKETPLACE_KEY_SECRET || 'test-secret-phrase';

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');
const wb = require('../src/marketplaces/wb');
const sync = require('../src/marketplaces/sync');

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
const realFetch = global.fetch;
async function api(method, path, { token, body } = {}) {
  const res = await realFetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}
const whIdOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).warehouseId;

// ---------- Поддельный WB ----------
// Склады — по ключу продавца: у Авезова три, у «Другого» один «ФФ Восток».
const WB = {
  warehouses: {
    avezov: [
      { id: 11, name: 'ФФ Восход СПБ / МСК', officeId: 500, cargoType: 1, deliveryType: 1 },
      { id: 12, name: 'ФФ Восток', officeId: 500, cargoType: 1, deliveryType: 1 },
      { id: 99, name: 'ФФ УФФ Самара / МСК', officeId: 900, cargoType: 1, deliveryType: 1 },
    ],
    other: [{ id: 31, name: 'ФФ Восток', officeId: 500, cargoType: 1, deliveryType: 1 }],
  },
  offices: [
    { id: 500, name: 'Коледино', city: 'Москва', address: 'д. Коледино, 20' },
    { id: 900, name: 'Самара', city: 'Самара', address: 'ул. Складская, 1' },
  ],
  queue: [],
  history: [],
  stocks: { 11: { 7001: 7 }, 12: { 7001: 3 } },
  warehousesFail: false,
  calls: [],
};
const whose = (token) => (String(token).includes('other') ? 'other' : 'avezov');
const order = (id, warehouseId, extra = {}) => ({
  externalId: String(id), article: 'ART-A', nmId: '111', barcodes: ['2000000000015'], rid: `r${id}`,
  orderUid: null, salePriceKopecks: 10000, createdAt: new Date(Date.now() - 3600e3).toISOString(),
  offices: ['Москва'], warehouseId: warehouseId == null ? null : String(warehouseId),
  chrtId: '7001', deliveryType: 'fbs', requiredMeta: [], ...extra,
});
wb.sellerInfo = async () => ({ name: 'ИП Авезов', inn: '1', tradeMark: 'A', sellerId: 's' });
wb.warehouses = async (token) => {
  WB.calls.push('warehouses');
  if (WB.warehousesFail) throw Object.assign(new Error('Wildberries не ответил вовремя'), { status: 504 });
  return WB.warehouses[whose(token)];
};
wb.offices = async () => { WB.calls.push('offices'); return WB.offices; };
wb.newOrders = async (token) => { WB.calls.push('new'); return whose(token) === 'avezov' ? WB.queue : []; };
wb.ordersHistory = async (token, { dateFrom, dateTo }) => {
  WB.calls.push('history');
  return { next: 0, orders: whose(token) !== 'avezov' ? [] : WB.history.filter((o) => {
    const t = new Date(o.createdAt).getTime() / 1000;
    return t >= dateFrom && t <= dateTo;
  }) };
};
wb.stocks = async (_, warehouseId, chrtIds) => {
  WB.calls.push(`stocks:${warehouseId}`);
  return chrtIds.filter((c) => WB.stocks[warehouseId]?.[c] != null)
    .map((c) => ({ chrtId: String(c), amount: WB.stocks[warehouseId][c] }));
};
wb.orderStatuses = async (_, ids) => ids.map((id) => ({ id: Number(id), supplierStatus: 'new', wbStatus: 'waiting' }));

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  // Сеть закрыта: ни одного настоящего запроса в WB из теста.
  global.fetch = async (input) => { throw new Error(`сеть в тесте закрыта: ${input}`); };
  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', { body: {
      name: 'Owner', email: `wbwh${stamp}@test.local`, password: 'secret123', warehouseName: 'Восход', city: 'Москва' } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const owner = reg.body.token;
    const warehouseId = whIdOf(owner);
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const companyId = (await api('POST', '/api/sellers/companies', { token: owner, body: { name: 'Авезов' } })).body.id;
    const otherId = (await api('POST', '/api/sellers/companies', { token: owner, body: { name: 'Другой' } })).body.id;
    const conn = await api('POST', '/api/marketplaces/credentials', { token: owner,
      body: { companyId, marketplace: 'wb', token: 'eyJ.fake.token' } });
    assert.equal(conn.status, 201, JSON.stringify(conn.body));
    await run((c) => c.query(
      `INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article, mp_barcode)
       VALUES ($1, $2, 'PB-A', 'wb', '111', 'ART-A', '2000000000015')`, [warehouseId, companyId]));
    await run((c) => c.query(`INSERT INTO products (warehouse_id, company_id, sku, name)
       VALUES ($1, $2, 'PB-A', 'Доска гладильная')`, [warehouseId, companyId]));

    // Заказы, заведённые до 30.09: склад у них не сохранён.
    const old = [order(1001, 11), order(1002, 99), order(1003, 99)];
    await run((c) => sync.importOrders(c, warehouseId, { companyId,
      orders: old.map((o) => ({ ...o, warehouseId: null, chrtId: null })) }));
    // У 1003 есть работа склада — комментарий: такой заказ не трогаем.
    await run((c) => c.query(
      `INSERT INTO invoice_comments (invoice_id, warehouse_id, company_id, author_role, author_name, body)
       SELECT id, warehouse_id, company_id, 'owner', 'Руководитель', 'проверить'
         FROM invoices WHERE external_id = '1003'`));
    WB.history = old;
    const invoicesOf = (id = companyId) => run(async (c) => (await c.query(
      `SELECT external_id, mp_warehouse_id FROM invoices WHERE company_id = $1 AND source = 'wb' ORDER BY external_id`,
      [id])).rows);
    const foreignOf = () => run(async (c) => (await c.query(
      'SELECT external_id FROM wb_foreign_orders WHERE company_id = $1 ORDER BY external_id', [companyId])).rows
      .map((r) => r.external_id));
    const ids = (rows) => rows.map((r) => r.external_id);

    // ---------- 1. Первый обмен: пункт с нашим именем Аргус добавил сам ----------
    WB.queue = [order(2001, 11), order(2002, 99)];
    const first = await api('POST', '/api/marketplaces/sync', { token: owner, body: { companyId } });
    check('склады продавца прочитаны у WB сразу при подключении ключа', () => {
      assert.equal(conn.body.warehouses.count, 3, JSON.stringify(conn.body));
      assert.equal(first.status, 200, JSON.stringify(first.body));
    });
    const listed = await api('GET', '/api/marketplaces', { token: owner });
    check('чей кабинет WB подключён — запомнено', () => {
      assert.equal(listed.body.find((m) => m.companyId === companyId).sellerName, 'ИП Авезов');
    });
    check('заказ чужого склада из очереди в работу не взят', () => assert.equal(first.body.foreign, 1));
    let inv = await invoicesOf();
    check('в работе — заказы нашего склада и заказ, по которому склад уже работает', () => {
      assert.deepEqual(ids(inv), ['1001', '1003', '2001']);
    });
    check('склад старых заказов узнан из истории WB', () => {
      assert.deepEqual(inv.map((r) => r.mp_warehouse_id), ['11', '99', '11']);
    });
    const hiddenNow = await foreignOf();
    check('чужие заказы без работы склада не удалены, а отложены', () => assert.deepEqual(hiddenNow, ['1002', '2002']));
    const chrt = await run(async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM invoice_items WHERE company_id = $1 AND mp_chrt_id = '7001'`, [companyId])).rows[0].n);
    check('размер WB (chrtId) записан у заказов — по нему читаются остатки', () => assert.equal(chrt, 3));
    const notes = await run(async (c) => (await c.query(
      `SELECT action_text FROM journal_entries WHERE warehouse_id = $1 AND entity_type = 'wb_warehouse'
        ORDER BY created_at`, [warehouseId])).rows.map((r) => r.action_text).join(' | '));
    check('в журнале — что Аргус сам добавил пункт приёмки', () => assert.match(notes, /сам добавил пункты приёмки/));

    // ---------- 2. Пункты приёмки ----------
    const offices = await api('GET', '/api/marketplaces/wb/offices', { token: owner });
    check('пункт с нашим именем уже добавлен, Самара — нет', () => {
      assert.equal(offices.status, 200, JSON.stringify(offices.body));
      const byId = Object.fromEntries(offices.body.offices.map((o) => [o.id, o]));
      assert.equal(byId['500'].configured, true);
      assert.match(byId['500'].addedBy, /Аргус/);
      assert.equal(byId['900'].configured, false);
    });
    check('названия складов других фулфилментов в подсказке не показываются', () => {
      assert.ok(!JSON.stringify(offices.body).includes('УФФ'));
    });
    const listA = await api('GET', `/api/marketplaces/${companyId}/wb/warehouses`, { token: owner });
    check('у Авезова наш — склад с нашим именем; «ФФ Восток» на том же пункте — нет (у продавца есть склад с нашим именем)', () => {
      assert.equal(listA.status, 200, JSON.stringify(listA.body));
      const byId = Object.fromEntries(listA.body.warehouses.map((w) => [w.id, w]));
      assert.equal(byId['11'].ours, true);
      assert.equal(byId['11'].auto, true);
      assert.equal(byId['12'].ours, false);
      assert.equal(byId['99'], undefined, 'склад другого фулфилмента показан');
      assert.equal(listA.body.otherCount, 1);
    });

    // ---------- 3. «Слим Тим»: один склад на нашем пункте без нашего имени ----------
    const conn2 = await api('POST', '/api/marketplaces/credentials', { token: owner,
      body: { companyId: otherId, marketplace: 'wb', token: 'eyJ.other.token' } });
    assert.equal(conn2.status, 201, JSON.stringify(conn2.body));
    await api('POST', '/api/marketplaces/sync', { token: owner, body: { companyId: otherId } });
    const listB = await api('GET', `/api/marketplaces/${otherId}/wb/warehouses`, { token: owner });
    check('у продавца единственный склад на нашем пункте без нашего имени — он наш', () => {
      assert.equal(listB.body.warehouses.length, 1);
      assert.equal(listB.body.warehouses[0].ours, true);
    });

    // ---------- 4. Новые заказы чужого склада в работу не попадают ----------
    WB.queue = [order(2003, 99), order(2004, 11)];
    const second = await api('POST', '/api/marketplaces/sync', { token: owner, body: { companyId } });
    check('из очереди: чужой отложен, наш — в работе', () => {
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.seen, 2);
      assert.equal(second.body.foreign, 1);
      assert.equal(second.body.created, 1);
    });
    inv = await invoicesOf();
    check('в работе появился только 2004', () => assert.deepEqual(ids(inv), ['1001', '1003', '2001', '2004']));

    // ---------- 5. Продавец сам отмечает склады ----------
    const sk = await api('POST', `/api/sellers/companies/${companyId}/keys`, { token: owner, body: {} });
    const seller = (await api('POST', '/api/auth/seller/login', { body: { name: 'Авезов', keyCode: sk.body.key_code } })).body.token;
    const sk2 = await api('POST', `/api/sellers/companies/${otherId}/keys`, { token: owner, body: {} });
    const seller2 = (await api('POST', '/api/auth/seller/login', { body: { name: 'Другой', keyCode: sk2.body.key_code } })).body.token;
    assert.ok(seller && seller2, 'продавцы не вошли');
    const mine = await api('GET', '/api/sellers/wb-warehouses', { token: seller });
    check('продавец видит свои склады у нашего фулфилмента', () => {
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
      assert.deepEqual(mine.body.warehouses.map((w) => w.id).sort(), ['11', '12']);
      assert.equal(mine.body.ffName, 'Восход');
    });
    const theirs = await api('GET', '/api/sellers/wb-warehouses', { token: seller2 });
    const cross = await api('PATCH', '/api/sellers/wb-warehouses/11', { token: seller2, body: { ours: false } });
    check('другой продавец чужих складов не видит и отметить не может', () => {
      assert.equal(theirs.status, 200);
      assert.deepEqual(theirs.body.warehouses.map((w) => w.id), ['31']);
      assert.equal(cross.status, 404, JSON.stringify(cross.body));
    });
    const on99 = await api('PATCH', '/api/sellers/wb-warehouses/99', { token: seller, body: { ours: true } });
    check('продавец отметил склад нашим — его заказы вернулись в работу', () => {
      assert.equal(on99.status, 200, JSON.stringify(on99.body));
      assert.equal(on99.body.restored, 3);
    });
    inv = await invoicesOf();
    check('вернулись 1002, 2002, 2003 со складом', () => {
      assert.deepEqual(ids(inv), ['1001', '1002', '1003', '2001', '2002', '2003', '2004']);
      assert.equal(inv.find((r) => r.external_id === '2003').mp_warehouse_id, '99');
    });
    const pair = await run(async (c) => (await c.query(
      `SELECT id FROM invoices WHERE company_id = $1 AND external_id IN ('2001', '2002')`, [companyId])).rows);
    const mixed = await api('POST', '/api/supplies', { token: owner,
      body: { invoiceIds: pair.map((r) => r.id), marketplace: 'wb', destination: 'Коледино' } });
    check('поставка из заказов двух складов WB не составляется — WB такую не примет', () => {
      assert.equal(mixed.status, 400, JSON.stringify(mixed.body));
      assert.match(mixed.body.error, /одного склада WB/);
      assert.match(mixed.body.error, /ФФ Восход СПБ/);
    });
    const off99 = await api('PATCH', '/api/sellers/wb-warehouses/99', { token: seller, body: { ours: false } });
    check('снял отметку — заказы снова отложены', () => assert.equal(off99.body.hidden, 3));
    const decided = await run(async (c) => (await c.query(
      `SELECT decided_by FROM seller_wb_warehouses WHERE company_id = $1 AND mp_warehouse_id = '99'`, [companyId])).rows[0]);
    check('решение человека записано и правилом больше не меняется', () => {
      assert.equal(decided.decided_by, 'Продавец «Авезов»');
    });

    // ---------- 6. Остатки WB по нашим складам — только чтение ----------
    await run((c) => c.query(`UPDATE marketplace_credentials SET wb_stocks_at = NULL WHERE company_id = $1`, [companyId]));
    WB.calls = [];
    WB.queue = [];
    await api('POST', '/api/marketplaces/sync', { token: owner, body: { companyId } });
    const withStock = await api('GET', '/api/sellers/wb-warehouses', { token: seller });
    check('остатки прочитаны только по нашим складам', () => {
      assert.deepEqual(WB.calls.filter((x) => x.startsWith('stocks:')).sort(), ['stocks:11']);
    });
    check('продавец видит, сколько выставлено на WB по складу', () => {
      assert.deepEqual(withStock.body.stock, { 'PB-A': { 11: 7 } });
      assert.ok(withStock.body.stocksAt);
    });

    // ---------- 7. WB не отдал склады — заказы всё равно принимаются ----------
    WB.warehousesFail = true;
    WB.queue = [order(2005, 11)];
    await run((c) => c.query(`UPDATE marketplace_credentials SET wb_warehouses_at = NULL WHERE company_id = $1`, [companyId]));
    const failed = await api('POST', '/api/marketplaces/sync', { token: owner, body: { companyId } });
    check('ошибка чтения складов не ломает приём заказов', () => {
      assert.equal(failed.status, 200, JSON.stringify(failed.body));
      assert.ok(failed.body.warehouses.error);
      assert.equal(failed.body.created, 1);
    });
    WB.warehousesFail = false;

    // ---------- 8. Пункт убран: заказов с него нет; Аргус его сам не вернёт ----------
    const removed = await api('PUT', '/api/marketplaces/wb/offices/500', { token: owner, body: { on: false } });
    check('пункт убран — склады на нём больше не наши, их заказы отложены', () => {
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.equal(removed.body.hidden, 4);   // 1001, 2001, 2004, 2005; у 1003 — комментарий
    });
    inv = await invoicesOf();
    check('в работе остался только заказ с работой склада', () => assert.deepEqual(ids(inv), ['1003']));
    await run((c) => c.query(`UPDATE marketplace_credentials SET wb_warehouses_at = NULL WHERE company_id = $1`, [companyId]));
    await api('POST', '/api/marketplaces/sync', { token: owner, body: { companyId } });
    const again = await api('GET', '/api/marketplaces/wb/offices', { token: owner });
    check('убранный человеком пункт Аргус обратно не добавляет', () => {
      assert.equal(again.body.offices.find((o) => o.id === '500').configured, false);
    });
    const back = await api('PUT', '/api/marketplaces/wb/offices/500', { token: owner, body: { on: true } });
    check('пункт вернули — заказы вернулись', () => assert.equal(back.body.restored, 4));

    // ---------- 9. «Как нас называют продавцы» ----------
    const renamed = await api('PATCH', '/api/warehouses/me', { token: owner, body: { wbNames: ['Восток'] } });
    const listC = await api('GET', `/api/marketplaces/${companyId}/wb/warehouses`, { token: owner });
    check('добавили имя «Восток» — «ФФ Восток» у Авезова стал нашим сам', () => {
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.deepEqual(renamed.body.wb_names, ['Восток']);
      assert.equal(listC.body.warehouses.find((w) => w.id === '12').ours, true);
    });

    // ---------- 10. Настройки склада: анкета ----------
    const bad = await api('PATCH', '/api/warehouses/me', { token: owner, body: { timezone: 'Марс/Олимп' } });
    const setup = await api('PATCH', '/api/warehouses/me', { token: owner,
      body: { stockSource: 'argus', timezone: 'Asia/Novosibirsk', wbSuppliesBy: 'seller', setupDone: true } });
    check('анкета: неверный пояс не принят, ответы сохранены', () => {
      assert.equal(bad.status, 400);
      assert.equal(setup.body.stock_source, 'argus');
      assert.equal(setup.body.timezone, 'Asia/Novosibirsk');
      assert.equal(setup.body.wb_supplies_by, 'seller');
      assert.ok(setup.body.setup_at);
    });

    // ---------- 11. «Забрать у всех»: каждый продавец отдельно ----------
    WB.queue = [order(2006, 11)];
    const all = await api('POST', '/api/marketplaces/sync', { token: owner, body: {} });
    check('«забрать у всех» — по каждому продавцу свой итог, без ошибок', () => {
      assert.equal(all.status, 200, JSON.stringify(all.body));
      assert.deepEqual(all.body.map((r) => r.company).sort(), ['Авезов', 'Другой']);
      assert.ok(all.body.every((r) => !r.error), JSON.stringify(all.body));
      assert.equal(all.body.find((r) => r.company === 'Авезов').created, 1);
    });

    // ---------- 12. Работник к складам WB и настройкам не допущен ----------
    const staff = await api('POST', '/api/staff', { token: owner, body: { name: 'Грузчик' } });
    const worker = (await api('POST', '/api/auth/staff/login', { body: { keyCode: staff.body.key_code } })).body.token;
    const w1 = await api('GET', `/api/marketplaces/${companyId}/wb/warehouses`, { token: worker });
    const w2 = await api('PUT', '/api/marketplaces/wb/offices/500', { token: worker, body: { on: true } });
    const w3 = await api('PATCH', '/api/warehouses/me', { token: worker, body: { stockSource: '1c' } });
    check('грузчик не видит и не меняет склады WB и настройки склада', () => {
      assert.equal(w1.status, 403);
      assert.equal(w2.status, 403);
      assert.equal(w3.status, 403);
    });
  } catch (err) {
    failures.push({ name: 'тест упал', message: err.stack });
    console.log(err.stack);
  } finally {
    global.fetch = realFetch;
    server.close();
    const { pool } = require('../src/db/pool');
    await pool.end();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
