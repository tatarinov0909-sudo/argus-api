// Общие заготовки для независимой проверки 01.10.2026 (склады WB, анкета
// склада, обмен с WB). Только синтетические данные и только тестовая база.
//
// WB подменяется функциями модуля src/marketplaces/wb.js (как в
// test/wb-warehouses-e2e.js); настоящая сеть закрыта: любой fetch наружу —
// ошибка теста. Запросы к своему API идут через сохранённый fetch.
process.env.MARKETPLACE_KEY_SECRET = process.env.MARKETPLACE_KEY_SECRET || 'test-secret-for-local-only-000000';

const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Нужна отдельная тестовая база argus_seller_test_*');

const { createApp } = require('../../src/app');
const { pool, withTenantContext } = require('../../src/db/pool');
const wb = require('../../src/marketplaces/wb');

const realFetch = global.fetch;

// ---------- Поддельный WB: всё по строке ключа продавца ----------
const WB = {
  warehouses: {},   // ключ → [{ id, name, officeId }]
  queue: {},        // ключ → [заказ]
  statuses: {},     // id заказа → { supplierStatus, wbStatus }
  calls: [],
};
wb.sellerInfo = async (t) => ({ name: `ИП ${t}`, inn: '7700000000', tradeMark: t, sellerId: t });
wb.warehouses = async (t) => { WB.calls.push(`warehouses:${t}`); return (WB.warehouses[t] || []).map((w) => ({ cargoType: 1, deliveryType: 1, ...w })); };
wb.offices = async () => [];
wb.newOrders = async (t) => { WB.calls.push(`new:${t}`); return WB.queue[t] || []; };
wb.ordersHistory = async () => ({ next: 0, orders: [] });
wb.stocks = async () => [];
wb.orderStatuses = async (_, ids) => ids.map((id) => ({ id: Number(id), ...(WB.statuses[id] || { supplierStatus: 'new', wbStatus: 'waiting' }) }));
wb.shippingPoints = async () => [];

let orderSeq = 0;
// Сборочное задание WB в том виде, в каком его отдаёт wb.normalizeOrder.
function order(id, warehouseId, extra = {}) {
  orderSeq += 1;
  return {
    externalId: String(id), article: 'ART-1', nmId: '111', barcodes: ['2000000000011'], rid: `rid-${id}`,
    orderUid: null, salePriceKopecks: 10000, createdAt: new Date(Date.now() - 3600e3 + orderSeq * 1000).toISOString(),
    offices: ['Москва'], warehouseId: warehouseId == null ? null : String(warehouseId),
    chrtId: '7001', deliveryType: 'fbs', requiredMeta: [], ...extra,
  };
}

async function startApp() {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  global.fetch = async (input) => { throw new Error(`сеть в тесте закрыта: ${input}`); };
  async function raw(method, path, token, body) {
    const res = await realFetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json, headers: res.headers };
  }
  const api = raw;
  async function ok(method, path, token, body, status) {
    const r = await raw(method, path, token, body);
    const good = status !== undefined ? r.status === status : r.status < 300;
    if (!good) throw Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  const stop = async () => { global.fetch = realFetch; await new Promise((r) => server.close(r)); await pool.end(); };
  return { api, ok, stop, base };
}

const whIdOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')).warehouseId;
let uniq = 0;

// Склад (фулфилмент) с владельцем. name — название склада: по нему правило
// «наш склад WB» узнаёт склады продавцов.
async function warehouse(ok, name = 'Ромашка') {
  uniq += 1;
  const email = `a0110-${Date.now()}-${uniq}@example.test`;
  const password = 'test-only-password';
  const reg = await ok('POST', '/api/auth/owner/register', null, {
    name: 'Владелец', email, password, warehouseName: name, city: 'Москва',
  });
  const token = reg.token;
  const warehouseId = whIdOf(token);
  const run = (fn) => withTenantContext({ warehouseId }, fn);
  const q = async (sql, params = []) => (await run((c) => c.query(sql, params))).rows;
  // Продавец с ключом WB (строка ключа = имя в поддельном WB) и товаром,
  // сопоставленным с карточкой WB ART-1 / 111.
  const seller = async (companyName, wbKey, warehouses = []) => {
    WB.warehouses[wbKey] = warehouses;
    const companyId = (await ok('POST', '/api/sellers/companies', token, { name: companyName })).id;
    await ok('POST', '/api/products', token, { sku: `SKU-${wbKey}`, name: `Товар ${companyName}`, companyId });
    await q(`INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article, mp_barcode)
             VALUES ($1, $2, $3, 'wb', '111', 'ART-1', '2000000000011')`, [warehouseId, companyId, `SKU-${wbKey}`]);
    const conn = await ok('POST', '/api/marketplaces/credentials', token, { companyId, marketplace: 'wb', token: wbKey });
    return { companyId, conn };
  };
  const sync = (companyId) => ok('POST', '/api/marketplaces/sync', token, { companyId });
  // Заказы продавца «в работе» (в invoices) и отложенные (wb_foreign_orders).
  const inWork = async (companyId) => (await q(
    `SELECT external_id FROM invoices WHERE company_id = $1 AND source = 'wb' ORDER BY external_id`, [companyId]))
    .map((r) => r.external_id);
  const hidden = async (companyId) => (await q(
    'SELECT external_id FROM wb_foreign_orders WHERE company_id = $1 ORDER BY external_id', [companyId]))
    .map((r) => r.external_id);
  const whs = async (companyId) => q(
    `SELECT mp_warehouse_id AS id, name, ours, decided_by, gone_at FROM seller_wb_warehouses
      WHERE company_id = $1 ORDER BY mp_warehouse_id`, [companyId]);
  const worker = async (name = 'Грузчик', { manager = false, grants = [] } = {}) => {
    const key = await ok('POST', '/api/staff', token, { name, ...(manager ? { kind: 'manager', permissions: grants } : {}) });
    return (await ok('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
  };
  const sellerToken = async (companyId) => {
    const key = await ok('POST', `/api/sellers/companies/${companyId}/keys`, token, {});
    return (await ok('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Продавец' })).token;
  };
  return { token, email, password, warehouseId, run, q, seller, sync, inWork, hidden, whs, worker, sellerToken };
}

// Находка — не исключение на первой проверке, а список расхождений.
function verdicts(title) {
  const bad = [];
  let good = 0;
  return {
    expect(label, isOk, expected, got) {
      if (isOk) { good += 1; console.log(`  ok    ${label}`); return; }
      bad.push(label);
      console.log(`  FAIL  ${label}\n        ожидалось: ${expected}\n        получили:  ${got}`);
    },
    done() {
      console.log(`\n${title}: ${good} выдержало, ${bad.length} нарушений`);
      if (bad.length) process.exitCode = 1;
    },
  };
}

// Подключение суперпользователем — только для подготовки данных, которых
// нынешний API сделать не даёт. Только тестовая база.
async function admin(sql, params = []) {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url || !/\/argus_seller_test_/.test(url)) throw Error('Нужен ADMIN_DATABASE_URL на тестовую базу');
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

const fail = (err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; };

module.exports = { WB, order, startApp, warehouse, verdicts, admin, withTenantContext, fail, whIdOf };
