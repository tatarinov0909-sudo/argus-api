// Общие заготовки для атак 25.09.2026: поднять API в процессе, завести
// склад, продавцов, работника. Только синтетические данные.
const assert = require('node:assert/strict');

const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');

const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');

async function startApp() {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, path, token, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json };
  }
  async function ok(method, path, token, body, status) {
    const r = await api(method, path, token, body);
    if (status !== undefined) assert.equal(r.status, status, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    else assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  const stop = async () => { await new Promise((r) => server.close(r)); await pool.end(); };
  return { api, ok, stop };
}

const whIdOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')).warehouseId;
let uniq = 0;

async function warehouse(ok, label = 'atk') {
  uniq += 1;
  const reg = await ok('POST', '/api/auth/owner/register', null, {
    name: 'Attack owner', email: `${label}-${Date.now()}-${uniq}@example.test`, password: 'test-only-password',
    warehouseName: `Attack ${label}`, city: 'Test',
  });
  const token = reg.token;
  const warehouseId = whIdOf(token);
  const run = (fn) => withTenantContext({ warehouseId }, fn);
  const company = async (name) => (await ok('POST', '/api/sellers/companies', token, { name })).id;
  const worker = async (name = 'Test worker') => {
    const key = await ok('POST', '/api/staff', token, { name });
    return (await ok('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
  };
  const sellerToken = async (companyId) => {
    const key = await ok('POST', `/api/sellers/companies/${companyId}/keys`, token, {});
    return (await ok('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Test seller' })).token;
  };
  // Ряды ячеек; blocks — плоский список блоков 1x1 с координатами.
  const cells = async (configs) => {
    await ok('POST', '/api/cells/rows', token, { configs });
    const rows = await ok('GET', '/api/cells/rows', token);
    return rows.flatMap((r) => r.blocks.map((b) => ({ ...b, row_num: r.row_num })));
  };
  return { token, warehouseId, run, company, worker, sellerToken, cells };
}

module.exports = { startApp, warehouse, withTenantContext, assert };
