// Приёмка: что нельзя принять и что нельзя принять дважды.
//
// Оба случая приходят из жизни склада. Первый: работник (или устаревший
// экран) отправляет на приёмку строку заказа НА ОТГРУЗКУ — товар приписался
// бы на полку, а сам заказ закрылся бы несобранным. Второй: двойной тап или
// повтор по таймауту — количество ложилось в ячейку дважды, и в 1С уезжали
// два прихода.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Нужна отдельная тестовая база и ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

  try {
    const stamp = `${Date.now()}-${process.pid}`;
    const owner = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Приёмка', email: `recv-${stamp}@test.local`, password: 'synthetic-pass-123',
      warehouseName: 'Приёмка WH', city: 'Москва',
    }), 201);
    const warehouseId = JSON.parse(Buffer.from(owner.token.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner.token, { name: 'Продавец' }), 201);
    const staff = must(await api('POST', '/api/staff', owner.token, { name: 'Грузчик' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code }));
    must(await api('POST', '/api/cells/rows', owner.token, { configs: [{ rackCount: 2, tierCount: 1 }] }), 201);
    const cell = must(await api('GET', '/api/cells/rows', owner.token)).flatMap((r) => r.blocks)[0].id;
    must(await api('POST', '/api/products', owner.token, { companyId: company.id, sku: 'RC-1', name: 'Товар приёмки' }), 201);

    // ---------- Заказ на отгрузку нельзя «принять» ----------
    const order = must(await api('POST', '/api/invoices', owner.token, {
      companyId: company.id, number: `OUT-${stamp}`, direction: 'out',
      items: [{ sku: 'RC-1', name: 'Товар приёмки', declaredQty: 4 }],
    }), 201);
    const wrong = await api('POST', '/api/receiving', worker.token,
      { invoiceItemId: order.items[0].id, acceptedQty: 4, cellBlockId: cell });
    const afterWrong = await run((c) => c.query(
      'SELECT COALESCE(SUM(qty), 0) AS qty FROM cell_stock WHERE cell_block_id = $1', [cell]));
    check('строку заказа на отгрузку принять нельзя', () => {
      assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
      assert.equal(Number(afterWrong.rows[0].qty), 0, 'товар заказа попал на полку');
    });
    const orderState = await run((c) => c.query('SELECT status FROM invoices WHERE id = $1', [order.id]));
    check('и сам заказ остался в работе, а не закрылся приёмкой', () => {
      assert.notEqual(orderState.rows[0].status, 'completed');
    });

    // ---------- Двойное нажатие «принять» ----------
    const receipt = must(await api('POST', '/api/invoices', owner.token, {
      companyId: company.id, number: `IN-${stamp}`,
      items: [{ sku: 'RC-1', name: 'Товар приёмки', declaredQty: 10 }],
    }), 201);
    const body = { invoiceItemId: receipt.items[0].id, acceptedQty: 10, cellBlockId: cell };
    const [first, second] = await Promise.all([
      api('POST', '/api/receiving', worker.token, body),
      api('POST', '/api/receiving', worker.token, body),
    ]);
    const stock = await run((c) => c.query(
      'SELECT COALESCE(SUM(qty), 0) AS qty FROM cell_stock WHERE cell_block_id = $1', [cell]));
    const records = await run((c) => c.query(
      'SELECT count(*)::int AS n FROM receiving_records WHERE invoice_item_id = $1', [receipt.items[0].id]));
    check('два одновременных нажатия «принять» дают одну приёмку', () => {
      const codes = [first.status, second.status].sort();
      assert.deepEqual(codes, [201, 409], JSON.stringify([first.body, second.body]));
      assert.equal(records.rows[0].n, 1, 'записей приёмки больше одной');
      assert.equal(Number(stock.rows[0].qty), 10, 'в ячейке лежит не то количество');
    });

    console.log(`\n${passed} прошло, ${failures.length} упало`);
  } finally {
    await new Promise((r) => server.close(r));
  }
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
