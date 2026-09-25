// Пауза грузчика видна руководителю в журнале сразу — и постановка, и
// возврат к работе (владелец 26.09.2026). Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Worker pause E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');

(async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let passed = 0;
  const check = (label, fn) => { fn(); passed += 1; console.log(`PASS ${label}`); };
  async function api(method, path, token, body) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const must = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body; };
  try {
    const stamp = `${Date.now()}-${process.pid}`;
    const owner = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Pause test', email: `pause-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Pause test', city: 'Test',
    }), 201).token;
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Слим Тест' }), 201).id;
    const staff = must(await api('POST', '/api/staff', owner, { name: 'Грузчик Иван' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code })).token;
    const mgrKey = must(await api('POST', '/api/staff', owner, { name: 'Менеджер', kind: 'manager' }), 201);
    const manager = must(await api('POST', '/api/auth/staff/login', null, { keyCode: mgrKey.key_code })).token;
    const order = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'WB-1', direction: 'out',
      items: [{ sku: 'PB-1', name: 'Батончик', declaredQty: 1 }] }), 201);

    must(await api('POST', '/api/journal/pause', worker, { invoiceId: order.id, reason: 'Перерыв' }), 201);
    must(await api('POST', '/api/journal/pause', worker, { invoiceId: order.id, reason: 'Перерыв', resumed: true, pausedMs: 12 * 60000 }), 201);
    must(await api('POST', '/api/journal/pause', worker, { invoiceId: 'supply:not-a-uuid', reason: 'Жду уточнения' }), 201);

    const seen = must(await api('GET', '/api/journal', manager)).filter((e) => e.entity_type === 'worker_pause');
    check('менеджер видит паузу и возврат с именем, причиной и документом', () => {
      const texts = seen.map((e) => e.action_text).join('\n');
      assert.match(texts, /Грузчик Иван поставил работу на паузу: Перерыв\. Документ «WB-1»/);
      assert.match(texts, /вернулся к работе после паузы \(12 мин\): Перерыв/);
      assert.ok(seen.some((e) => e.invoice_id === order.id), 'ссылка на документ');
    });
    check('чужой номер документа не роняет запрос — пауза записана без ссылки', () => {
      assert.ok(seen.some((e) => /Жду уточнения\.$/.test(e.action_text) && !e.invoice_id));
    });

    const empty = await api('POST', '/api/journal/pause', worker, { invoiceId: order.id, reason: '  ' });
    const byOwner = await api('POST', '/api/journal/pause', owner, { reason: 'Перерыв' });
    check('без причины — 400; ставить паузу может только работник', () => {
      assert.equal(empty.status, 400);
      assert.equal(byOwner.status, 403);
    });

    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error('FAIL', e);
    process.exitCode = 1;
  } finally {
    server.close();
    await require('../src/db/pool').pool.end();
  }
})();
