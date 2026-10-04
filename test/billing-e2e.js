// Расчёты с продавцами, первая версия (04.10.2026): прайс склада, начисления
// за месяц из записанных операций и дневной занятости, показ продавцу только
// с разрешения склада, права. Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, token, body, status = 200) => {
    const res = await fetch(base + path, { method, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    assert.equal(res.status, status, `${method} ${path}: ${res.status} ${json && json.error || ''}`);
    return json;
  };
  let passed = 0;
  const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
  try {
    const register = async (name) => (await api('POST', '/api/auth/owner/register', null, {
      name, email: `billing-${name}-${Date.now()}@example.test`, password: 'test-only-password', warehouseName: name, city: 'Test',
    }, 201)).token;
    const owner = await register('Деньги');
    const stranger = await register('Чужой');
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const db = (sql, args) => withTenantContext({ warehouseId }, (c) => c.query(sql, args));
    const a = await api('POST', '/api/sellers/companies', owner, { name: 'Счёт А' }, 201);
    const key = await api('POST', `/api/sellers/companies/${a.id}/keys`, owner, {}, 201);
    const seller = (await api('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Продавец' })).token;
    const wk = await api('POST', '/api/staff', owner, { name: 'Грузчик' }, 201);
    const worker = (await api('POST', '/api/auth/staff/login', null, { keyCode: wk.key_code })).token;
    await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 3, tierCount: 1 }] }, 201);
    const cells = (await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks).map((x) => x.id);
    await db(`INSERT INTO products (warehouse_id, company_id, sku, name) VALUES ($1, $2, 'BL-1', 'Чай')`, [warehouseId, a.id]);
    const inv = await api('POST', '/api/invoices', owner, { companyId: a.id, number: 'ПР-ДЕНЬГИ',
      items: [{ sku: 'BL-1', name: 'Чай', declaredQty: 10 }] }, 201);
    await api('POST', `/api/receiving/session/${inv.id}/start`, worker, {}, 201);
    await api('POST', '/api/receiving', worker, { invoiceItemId: inv.items[0].id, acceptedQty: 7,
      placements: [{ cellBlockId: cells[0], qty: 4 }, { cellBlockId: cells[1], qty: 3 }] }, 201);
    const tz = (await db('SELECT timezone FROM warehouses WHERE id = $1', [warehouseId])).rows[0].timezone || 'Europe/Moscow';
    const month = new Date().toLocaleDateString('sv-SE', { timeZone: tz }).slice(0, 7);

    const t0 = await api('GET', '/api/warehouses/billing/tariff', owner);
    assert.equal(t0.approximate, true); assert.equal(t0.showSellers, false);
    check('пока прайс не сохранён, цены примерные и продавцам не показываются');

    const c0 = await api('GET', `/api/warehouses/billing/charges?month=${month}`, owner);
    const lineOf = (s, key) => s.lines.find((l) => l.service === key);
    const sa = c0.sellers.find((s) => s.companyId === a.id);
    assert.equal(lineOf(sa, 'receiving').qty, 7);
    assert.equal(lineOf(sa, 'receiving').amount, 7 * t0.prices.receiving);
    assert.equal(lineOf(sa, 'receiving').details[0].label, 'ПР-ДЕНЬГИ');
    assert.equal(lineOf(sa, 'storage').qty, 2, 'две занятые ячейки за сегодня');
    assert.equal(sa.total, sa.lines.reduce((x, l) => x + l.amount, 0));
    check('приёмка по штукам с номером прихода, хранение по ячейкам за сутки, итог сходится');

    assert.deepEqual(await api('GET', `/api/sellers/billing?month=${month}`, seller), { enabled: false });
    check('продавец не видит расчёт, пока склад не включил показ');

    await api('PUT', '/api/warehouses/billing/tariff', owner, { prices: { storage: 1.5, receiving: 'abc', picking: 10, returns: 10 }, storageUnit: 'unit_day' }, 400);
    await api('PUT', '/api/warehouses/billing/tariff', owner, { prices: { storage: 1, receiving: 5, picking: 10, returns: 10 }, storageUnit: 'pallet' }, 400);
    await api('PUT', '/api/warehouses/billing/tariff', worker, { prices: {}, storageUnit: 'unit_day' }, 403);
    await api('GET', `/api/warehouses/billing/charges?month=2026-13`, owner, undefined, 400);
    check('кривая цена, единица хранения и месяц не принимаются; работнику прайс закрыт');

    const t1 = await api('PUT', '/api/warehouses/billing/tariff', owner, {
      prices: { storage: '0,5', receiving: 6, picking: 10, returns: 10 }, storageUnit: 'unit_day', showSellers: true });
    assert.equal(t1.approximate, false); assert.equal(t1.prices.storage, 0.5);
    const mine = await api('GET', `/api/sellers/billing?month=${month}`, seller);
    assert.equal(mine.enabled, true);
    assert.equal(lineOf(mine, 'receiving').amount, 42);
    assert.equal(lineOf(mine, 'storage').qty, 7, 'штук в сутки');
    assert.equal(lineOf(mine, 'storage').amount, 3.5);
    check('свой прайс: продавец видит тот же расчёт, хранение по штукам, копейки не теряются');

    const other = await api('GET', `/api/warehouses/billing/charges?month=${month}`, stranger);
    assert.ok(!other.sellers.some((s) => s.companyId === a.id));
    await api('GET', `/api/sellers/billing?month=${month}&companyId=${a.id}`, stranger, undefined, 404);
    check('чужой склад не видит ни продавца, ни его расчёта');

    const mk = await api('POST', '/api/staff', owner, { name: 'Менеджер', kind: 'manager', permissions: ['warehouse'] }, 201);
    const manager = (await api('POST', '/api/auth/staff/login', null, { keyCode: mk.key_code })).token;
    await api('GET', `/api/warehouses/billing/charges?month=${month}`, manager, undefined, 403);
    assert.deepEqual(await api('GET', `/api/sellers/billing?month=${month}&companyId=${a.id}`, manager), { enabled: false });
    const mk2 = await api('POST', '/api/staff', owner, { name: 'Бухгалтер', kind: 'manager', permissions: ['billing'] }, 201);
    const money = (await api('POST', '/api/auth/staff/login', null, { keyCode: mk2.key_code })).token;
    assert.equal((await api('GET', `/api/sellers/billing?month=${month}&companyId=${a.id}`, money)).enabled, true);
    check('менеджеру деньги — только с правом «тариф и деньги»');
    console.log(`\n${passed} passed`);
  } catch (err) {
    console.error('FAIL', err.message);
    process.exitCode = 1;
  } finally {
    server.close(); await pool.end();
  }
})();
