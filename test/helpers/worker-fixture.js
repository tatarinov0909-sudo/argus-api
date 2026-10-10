const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

function requireTestDatabase() {
  assert.equal(process.env.ARGUS_TEST_ALLOW_WRITES, '1', 'explicit test write permission required');
  for (const key of ['DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const url = new URL(process.env[key]);
    assert.equal(url.hostname, '127.0.0.1', 'worker tests use local disposable PostgreSQL only');
    assert.equal(url.port, '5433');
    assert.match(url.pathname, /^\/argus_seller_test_worker_[a-zA-Z0-9_]+$/);
  }
  assert.equal(new URL(process.env.DATABASE_URL).pathname, new URL(process.env.ADMIN_DATABASE_URL).pathname);
  assert.equal(new URL(process.env.DATABASE_URL).username, 'argus_app', 'test tenant isolation as restricted role');
}

function apiAt(base) {
  return async (method, path, token, body, id, offline = false) => {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(id ? { 'X-Argus-Operation-Id': id } : {}), ...(offline ? { 'X-Argus-Offline': '1' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), replayed: response.headers.get('X-Argus-Operation-Replayed') === '1' };
  };
}
function must(response, status = 200) { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body; }

async function fixture(api, name = 'Склад проверки приложения') {
  const stamp = randomUUID();
  const registration = must(await api('POST', '/api/auth/owner/register', null, {
    name: 'Тестовый руководитель', email: `${stamp}@example.invalid`, password: randomUUID(), warehouseName: name, city: 'Тест',
  }), 201);
  const owner = registration.token;
  const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
  const companyId = must(await api('POST', '/api/sellers/companies', owner, { name: 'Тестовый продавец' }), 201).id;
  for (const [sku, product] of [['TEST-1', 'Коробка с товарами для проверки'], ['TEST-2', 'Вторая позиция приёмки']]) {
    must(await api('POST', '/api/products', owner, { sku, name: product, companyId }), 201);
  }
  must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 4, tierCount: 1 }] }), 201);
  const cells = must(await api('GET', '/api/cells/rows', owner)).filter((r) => r.row_num > 0).flatMap((r) => r.blocks);
  const key = must(await api('POST', '/api/staff', owner, { name: 'Тестовый грузчик' }), 201);
  const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
  const invoice = must(await api('POST', '/api/invoices', owner, { companyId, number: 'ТЕСТ-ПРИЁМКА',
    items: [{ sku: 'TEST-1', name: 'Коробка с товарами для проверки', declaredQty: 100 }, { sku: 'TEST-2', name: 'Вторая позиция приёмки', declaredQty: 5 }],
  }), 201);
  return { owner, worker, warehouseId, companyId, cells, invoice, staffKeyId: key.id, keyCode: key.key_code };
}

module.exports = { apiAt, fixture, must, requireTestDatabase };
