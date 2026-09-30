// Выкладка правила «заказы только с наших складов WB» на работающий склад
// (30.09.2026). До обновления пункты приёмки не заданы, отметки складов
// пустые. Проверяем: пока Аргус не решил, куда возит склад, ни один заказ не
// прячется; на первом обмене Аргус сам добавляет пункты по складам с именем
// склада, и уходят только заказы складов других фулфилментов.

process.env.MARKETPLACE_KEY_SECRET = process.env.MARKETPLACE_KEY_SECRET || 'test-secret-phrase';
const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');
const wb = require('../src/marketplaces/wb');
const sync = require('../src/marketplaces/sync');
const sellerWarehouses = require('../src/marketplaces/sellerWarehouses');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
const realFetch = global.fetch;
const order = (id, wh) => ({ externalId: String(id), article: 'ART', nmId: '1', barcodes: [], rid: `r${id}`,
  salePriceKopecks: 100, createdAt: new Date().toISOString(), offices: [], warehouseId: String(wh), chrtId: null });
wb.sellerInfo = async () => ({ name: 'ИП Тест', inn: '1' });
wb.warehouses = async (token) => (String(token).includes('slim') ? [{ id: 9, name: 'ФФ Восток', officeId: 15 }] : [
  { id: 1, name: 'ФФ Восход ЮГ', officeId: 15 },
  { id: 2, name: 'ФФ Восход СПБ', officeId: 10999 },
  { id: 3, name: 'ФФ УФФ Самара', officeId: 128 },
]);
wb.offices = async () => [];
wb.newOrders = async () => [];
wb.ordersHistory = async () => ({ next: 0, orders: [] });
wb.stocks = async () => [];
wb.orderStatuses = async (_, ids) => ids.map((id) => ({ id: Number(id), supplierStatus: 'new', wbStatus: 'waiting' }));

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  global.fetch = async (input, init) => {
    if (String(input).startsWith(BASE)) return realFetch(input, init);
    throw new Error(`сеть в тесте закрыта: ${input}`);
  };
  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(BASE + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', { body: {
      name: 'O', email: `upg${stamp}@test.local`, password: 'secret123', warehouseName: 'Восход' } });
    const owner = reg.body.token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64').toString('utf8')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const companyId = (await api('POST', '/api/sellers/companies', { token: owner, body: { name: 'Авезов' } })).body.id;
    await api('POST', '/api/marketplaces/credentials', { token: owner, body: { companyId, marketplace: 'wb', token: 'eyJ.x.y' } });
    // Состояние «до обновления»: склады продавца известны, пунктов нет,
    // Аргус ещё не решал, отметок нет.
    await run(async (c) => {
      await c.query('DELETE FROM ff_wb_offices WHERE warehouse_id = $1', [warehouseId]);
      await c.query('UPDATE warehouses SET wb_offices_auto_at = NULL WHERE id = $1', [warehouseId]);
      await c.query('UPDATE seller_wb_warehouses SET ours = false WHERE warehouse_id = $1', [warehouseId]);
      await sync.importOrders(c, warehouseId, { companyId, orders: [order(11, 1), order(12, 2), order(13, 3)] });
    });
    const inWork = () => run(async (c) => (await c.query(
      `SELECT external_id FROM invoices WHERE company_id = $1 AND source = 'wb' ORDER BY 1`, [companyId])).rows.map((r) => r.external_id));

    // Заказ 13 уже закрыт на WB (принят): таким он и должен вернуться.
    const orig = await run(async (c) => (await c.query(
      `UPDATE invoices SET mp_closed_at = now() - interval '1 day', mp_close_reason = 'fulfilled',
              created_at = now() - interval '3 days'
        WHERE external_id = '13' RETURNING id, created_at, mp_closed_at`)).rows[0]);
    const early = await run((c) => sellerWarehouses.settle(c, warehouseId, companyId, { importOrders: sync.importOrders }));
    check('пока не решено, куда возит склад, ни один заказ не прячется', () => assert.equal(early.hidden, 0));
    const before = await inWork();
    check('все три заказа в работе', () => assert.deepEqual(before, ['11', '12', '13']));

    const tick = await api('POST', '/api/marketplaces/sync', { token: owner, body: { companyId } });
    check('первый обмен после обновления прошёл', () => assert.equal(tick.status, 200, JSON.stringify(tick.body)));
    const marks = (await api('GET', `/api/marketplaces/${companyId}/wb/warehouses`, { token: owner })).body.warehouses;
    check('на первом обмене Аргус сам отметил склады с именем склада', () => {
      assert.deepEqual(marks.filter((w) => w.ours).map((w) => w.id).sort(), ['1', '2']);
    });
    const left = await inWork();
    check('ушёл только заказ склада другого фулфилмента', () => assert.deepEqual(left, ['11', '12']));

    // Человек решил, что склад 3 всё-таки наш: заказ вернулся тем же.
    const journalBefore = await run(async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE warehouse_id = $1 AND agent = 'Обмен с WB' AND entity_type = 'invoice'`,
      [warehouseId])).rows[0].n);
    const mark = await api('PATCH', `/api/marketplaces/${companyId}/wb/warehouses/3`, { token: owner, body: { ours: true } });
    await api('POST', '/api/marketplaces/sync', { token: owner, body: { companyId } });
    const back = await run(async (c) => (await c.query(
      `SELECT id, created_at, mp_closed_at FROM invoices WHERE external_id = '13'`)).rows[0]);
    const journalAfter = await run(async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE warehouse_id = $1 AND agent = 'Обмен с WB' AND entity_type = 'invoice'`,
      [warehouseId])).rows[0].n);
    check('возвращённый заказ — тот же: номер записи, дата, закрытие на WB', () => {
      assert.equal(mark.body.restored, 1, JSON.stringify(mark.body));
      assert.equal(back.id, orig.id);
      assert.equal(new Date(back.created_at).getTime(), new Date(orig.created_at).getTime());
      assert.ok(back.mp_closed_at, 'заказ снова открыт');
    });
    check('обмен не закрывал его заново — журнал не засыпан', () => assert.equal(journalAfter, journalBefore));

    // ---------- Как на рабочем сервере 30.09: пункты добавлены руками, у
    // второго продавца единственный склад «ФФ Восток» на нашем пункте, по
    // старому правилу не отмечен. Обновление не должно спрятать его заказы.
    const reg2 = await api('POST', '/api/auth/owner/register', { body: {
      name: 'O2', email: `upg2${stamp}@test.local`, password: 'secret123', warehouseName: 'Восход' } });
    const owner2 = reg2.body.token;
    const wh2 = JSON.parse(Buffer.from(owner2.split('.')[1], 'base64').toString('utf8')).warehouseId;
    const run2 = (fn) => withTenantContext({ warehouseId: wh2 }, fn);
    const av = (await api('POST', '/api/sellers/companies', { token: owner2, body: { name: 'Авезов' } })).body.id;
    const slim = (await api('POST', '/api/sellers/companies', { token: owner2, body: { name: 'Слим' } })).body.id;
    await api('POST', '/api/marketplaces/credentials', { token: owner2, body: { companyId: av, marketplace: 'wb', token: 'eyJ.av.y' } });
    await api('POST', '/api/marketplaces/credentials', { token: owner2, body: { companyId: slim, marketplace: 'wb', token: 'eyJ.slim.y' } });
    await run2(async (c) => {
      await c.query('UPDATE warehouses SET wb_offices_auto_at = NULL WHERE id = $1', [wh2]);
      await c.query(`UPDATE seller_wb_warehouses SET ours = (name ILIKE '%восход%') WHERE warehouse_id = $1`, [wh2]);
      await c.query(`INSERT INTO ff_wb_offices (warehouse_id, office_id, added_by) VALUES ($1, 15, 'Руководитель склада'), ($1, 10999, 'Руководитель склада')
                     ON CONFLICT DO NOTHING`, [wh2]);
      await sync.importOrders(c, wh2, { companyId: slim, orders: [order(91, 9), order(92, 9)] });
    });
    const tick2 = await api('POST', '/api/marketplaces/sync', { token: owner2, body: { companyId: slim } });
    const slimWork = await run2(async (c) => (await c.query(
      `SELECT external_id FROM invoices WHERE company_id = $1 AND source = 'wb' ORDER BY 1`, [slim])).rows.map((r) => r.external_id));
    const slimWh = await run2(async (c) => (await c.query(
      `SELECT ours FROM seller_wb_warehouses WHERE company_id = $1`, [slim])).rows[0]);
    check('обновление на складе с пунктами: единственный склад продавца на нашем пункте стал нашим, заказы на месте', () => {
      assert.equal(tick2.status, 200, JSON.stringify(tick2.body));
      assert.equal(slimWh.ours, true);
      assert.deepEqual(slimWork, ['91', '92']);
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
