// Очередь для 1С: событие, закоммиченное позже соседнего, не должно пропасть.
//
// Номер строке выдаётся при INSERT, а видимой она становится при COMMIT.
// Приёмка, начатая раньше, но зафиксированная позже, получает МЕНЬШИЙ номер
// и появляется уже ЗА курсором 1С. Пока выборка шла строго «id > курсора»,
// такое событие не возвращалось никогда: движение остатка терялось молча, и
// 1С навсегда расходилась со складом.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Нужна отдельная тестовая база и ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const outbox = require('../src/sync/outbox');

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

// Клиент с открытой транзакцией и контекстом склада — чтобы держать её
// незакоммиченной столько, сколько нужно тесту.
async function openTx(warehouseId) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.current_warehouse_id', warehouseId]);
  await client.query('SELECT set_config($1, $2, true)', ['app.current_company_id', '']);
  return client;
}

(async () => {
  const stamp = `${Date.now()}-${process.pid}`;
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, token, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    assert.ok(res.ok, `${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  let warehouseId;
  let companyId;
  try {
    const owner = await api('/api/auth/owner/register', null, {
      name: 'Очередь', email: `outbox-${stamp}@test.local`, password: 'synthetic-pass-123',
      warehouseName: 'Очередь WH', city: 'Москва',
    });
    warehouseId = JSON.parse(Buffer.from(owner.token.split('.')[1], 'base64url')).warehouseId;
    companyId = (await api('/api/sellers/companies', owner.token, { name: `Продавец ${stamp}` })).id;

    const event = (client, sku) => outbox.appendInventory(client, {
      warehouseId, companyId, cellLabel: '1.1.1', changes: [{ sku, diff: 1 }],
    });

    // Первый кладовщик начал раньше и ещё не закоммитился.
    const slow = await openTx(warehouseId);
    await event(slow, 'SLOW-1');
    // Второй начал позже и закоммитился первым.
    await withTenantContext({ warehouseId }, (client) => event(client, 'FAST-1'));

    const firstPage = await withTenantContext({ warehouseId },
      (client) => outbox.listSince(client, warehouseId, { since: 0 }));
    check('1С видит только закоммиченное событие', () => {
      assert.deepEqual(firstPage.map((e) => e.payload.lines[0].sku), ['FAST-1']);
    });

    // 1С подтверждает то, что получила, и двигает курсор.
    const cursor = Number(firstPage[firstPage.length - 1].id);
    await withTenantContext({ warehouseId },
      (client) => outbox.markDelivered(client, warehouseId, cursor, firstPage.map((e) => Number(e.id))));

    // И только теперь коммитится первый кладовщик.
    await slow.query('COMMIT');
    slow.release();

    const secondPage = await withTenantContext({ warehouseId },
      (client) => outbox.listSince(client, warehouseId, { since: cursor }));
    check('отставшее событие приходит следующим опросом, а не теряется', () => {
      assert.deepEqual(secondPage.map((e) => e.payload.lines[0].sku), ['SLOW-1'],
        JSON.stringify(secondPage.map((e) => e.id)));
    });

    const pending = await withTenantContext({ warehouseId },
      (client) => outbox.pendingCount(client, warehouseId));
    check('и владелец видит его в «не доставлено», пока 1С не подтвердит', () => {
      assert.equal(Number(pending), 1);
    });

    // Подтверждение по номерам не штампует чужие строки.
    await withTenantContext({ warehouseId }, (client) => event(client, 'NEXT-1'));
    const page = await withTenantContext({ warehouseId },
      (client) => outbox.listSince(client, warehouseId, { since: cursor }));
    const onlySlow = page.filter((e) => e.payload.lines[0].sku === 'SLOW-1').map((e) => Number(e.id));
    await withTenantContext({ warehouseId },
      (client) => outbox.markDelivered(client, warehouseId, 0, onlySlow));
    const stillPending = await withTenantContext({ warehouseId },
      (client) => outbox.pendingCount(client, warehouseId));
    check('подтверждение по списку номеров закрывает ровно названные события', () => {
      assert.equal(Number(stillPending), 1, 'осталось не то количество неподтверждённых');
    });

    console.log(`\n${passed} прошло, ${failures.length} упало`);
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
  }
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
