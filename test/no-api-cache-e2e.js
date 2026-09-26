// Ответы API браузер не хранит (27.09.2026): иначе ответ «не изменилось» из
// кэша отдавал странице продлённый вход другого человека этого же браузера —
// грузчик получал токен владельца. Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const reg = await fetch(base + '/api/auth/owner/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Cache', email: `cache-${Date.now()}@test.local`, password: 'test-only-password', warehouseName: 'Cache', city: 'Test' }) });
    const { token } = await reg.json();
    // Вход, которому пора продлиться: ответ несёт X-Argus-Token.
    const { iat, exp, ...claims } = jwt.decode(token);
    const now = Math.floor(Date.now() / 1000);
    const old = jwt.sign({ ...claims, iat: now - 7 * 3600, exp: now + 5 * 3600 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    const first = await fetch(base + '/api/cells/rows', { headers: { Authorization: `Bearer ${old}` } });
    await first.text();
    assert.ok(first.headers.get('x-argus-token'), 'old owner login is renewed');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.headers.get('etag'), null);
    const again = await fetch(base + '/api/cells/rows', { headers: { Authorization: `Bearer ${token}`, 'If-None-Match': 'W/"anything"' } });
    await again.text();
    assert.equal(again.status, 200, 'no 304 from a cached answer of someone else');
    console.log('PASS API answers are never cached: no-store, no ETag, no 304');
  } finally {
    await new Promise((r) => server.close(r)); await pool.end();
  }
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
