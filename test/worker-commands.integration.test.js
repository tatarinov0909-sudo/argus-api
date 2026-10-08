const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { apiAt, fixture, must, requireTestDatabase } = require('./helpers/worker-fixture');

test('worker command replay, QR verification and ordered offline pause events', { skip: process.env.ARGUS_TEST_ALLOW_WRITES !== '1' }, async (t) => {
  requireTestDatabase();
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  const { createApp } = require('../src/app');
  const { pool, withTenantContext } = require('../src/db/pool');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = apiAt(`http://127.0.0.1:${server.address().port}`);
  try {
    const a = await fixture(api), b = await fixture(api, 'Другой тестовый склад');
    const firstItem = a.invoice.items.find((item) => item.sku === 'TEST-1').id;
    const stock = async (cell) => Number((await admin.query('SELECT COALESCE(SUM(qty),0) AS n FROM cell_stock WHERE cell_block_id=$1 AND sku=$2', [cell, 'TEST-1'])).rows[0].n);
    const commandCount = async (id) => Number((await admin.query('SELECT count(*) AS n FROM worker_commands WHERE operation_id=$1', [id])).rows[0].n);
    const start = must(await api('POST', `/api/receiving/session/${a.invoice.id}/start`, a.worker, {}, randomUUID()), 201);
    const workSessionId = start.assembly.id;
    const qr1 = must(await api('GET', `/api/worker/cells/${a.cells[0].id}/qr`, a.worker)).qr;
    const qr2 = must(await api('GET', `/api/worker/cells/${a.cells[1].id}/qr`, a.worker)).qr;
    const receipt = { invoiceItemId: firstItem, acceptedQty: 100, placements: [{ cellBlockId: a.cells[0].id, qty: 40, cellQr: qr1 }], workSessionId, expected: { received: false }, occurredAt: new Date().toISOString() };
    const receiptId = randomUUID();

    await t.test('capabilities are explicit; QR is tenant scoped and resolves to a real cell', async () => {
      const cap = must(await api('GET', '/api/worker/capabilities', a.worker));
      assert.equal(cap.offline.version, 1);
      assert.equal(cap.offline.supportedOperations.length, 3);
      assert.equal(must(await api('POST', '/api/worker/cells/resolve', a.worker, { qr: qr1 })).cellBlockId, a.cells[0].id);
      assert.equal((await api('GET', `/api/worker/cells/${a.cells[0].id}/qr`, b.worker)).status, 404);
      assert.equal((await api('POST', '/api/worker/cells/resolve', b.worker, { qr: qr1 })).body.code, 'wrong_cell_warehouse');
      assert.equal((await api('POST', '/api/worker/cells/resolve', a.worker, { qr: a.cells[0].id })).status, 400);
    });
    await t.test('concurrent receipt with one ID commits once and returns the same result', async () => {
      const responses = await Promise.all(Array.from({ length: 6 }, () => api('POST', '/api/receiving', a.worker, receipt, receiptId, true)));
      responses.forEach((r) => { must(r, 201); assert.deepEqual(r.body, responses[0].body); });
      assert.equal(responses.filter((r) => !r.replayed).length, 1);
      assert.equal(await stock(a.cells[0].id), 40);
      assert.equal(await commandCount(receiptId), 1);
      assert.equal(Number((await admin.query('SELECT count(*) n FROM receiving_records WHERE invoice_item_id=$1', [firstItem])).rows[0].n), 1);
    });
    await t.test('lost acknowledgement replays; payload and actor changes never run', async () => {
      const retry = await api('POST', '/api/receiving', a.worker, JSON.parse(JSON.stringify(receipt)), receiptId, true);
      must(retry, 201); assert.equal(retry.replayed, true);
      const changed = await api('POST', '/api/receiving', a.worker, { ...receipt, acceptedQty: 99 }, receiptId, true);
      assert.equal(changed.body.code, 'operation_changed');
      const key = must(await api('POST', '/api/staff', a.owner, { name: 'Второй тестовый грузчик' }), 201);
      const worker2 = must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
      assert.equal((await api('POST', '/api/receiving', worker2, receipt, receiptId, true)).body.code, 'operation_changed');
      assert.equal(await stock(a.cells[0].id), 40);
    });
    const placement = { cellBlockId: a.cells[1].id, qty: 10, cellQr: qr2, workSessionId, expected: { unplacedQty: 60 }, occurredAt: new Date().toISOString() };
    const placePath = `/api/receiving/items/${firstItem}/place`;
    const placeId = randomUUID();
    await t.test('wrong scans and stale counts roll back both command and movement', async () => {
      const wrongId = randomUUID();
      assert.equal((await api('POST', placePath, a.worker, { ...placement, cellQr: qr1 }, wrongId, true)).body.code, 'wrong_cell');
      assert.equal(await commandCount(wrongId), 0);
      const staleId = randomUUID();
      assert.equal((await api('POST', placePath, a.worker, { ...placement, expected: { unplacedQty: 61 } }, staleId, true)).body.code, 'placement_changed');
      assert.equal(await commandCount(staleId), 0);
      const foreignQr = must(await api('GET', `/api/worker/cells/${b.cells[0].id}/qr`, b.worker)).qr;
      assert.equal((await api('POST', placePath, a.worker, { ...placement, cellQr: foreignQr }, randomUUID(), true)).body.code, 'wrong_cell_warehouse');
      assert.equal(await stock(a.cells[1].id), 0);
    });
    await t.test('partial placement cannot double count after lost response or concurrent repeat', async () => {
      const [one, two] = await Promise.all([api('POST', placePath, a.worker, placement, placeId, true), api('POST', placePath, a.worker, placement, placeId, true)]);
      must(one, 201); must(two, 201); assert.deepEqual(one.body, two.body);
      assert.equal(await stock(a.cells[1].id), 10);
      assert.equal((await api('POST', placePath, a.worker, placement, randomUUID(), true)).body.code, 'placement_changed');
      assert.equal(await stock(a.cells[1].id), 10);
    });
    await t.test('an operation rejected after guard leaves no command receipt', async () => {
      const id = randomUUID();
      const bad = await api('POST', placePath, a.worker, { ...placement, qty: 51, expected: { unplacedQty: 50 } }, id, true);
      assert.equal(bad.status, 400); assert.equal(bad.body.code, 'worker_command_rejected');
      assert.equal(await commandCount(id), 0); assert.equal(await stock(a.cells[1].id), 10);
      const good = await api('POST', placePath, a.worker, { ...placement, qty: 5, expected: { unplacedQty: 50 } }, id, true);
      must(good, 201); assert.equal(await stock(a.cells[1].id), 15);
    });
    await t.test('online move replays once, while unimplemented offline movement is refused', async () => {
      const path = '/api/cells/move';
      const body = { companyId: a.companyId, sku: 'TEST-1', fromCellBlockId: a.cells[0].id, toCellBlockId: a.cells[2].id, qty: 5 };
      const id = randomUUID();
      const first = await api('POST', path, a.worker, body, id);
      must(first, 201); assert.deepEqual(must(await api('POST', path, a.worker, body, id), 201), first.body);
      assert.equal(await stock(a.cells[2].id), 5);
      assert.equal((await api('POST', path, a.worker, body, randomUUID(), true)).body.code, 'offline_not_supported');
      assert.equal((await api('POST', placePath, a.worker, placement, null, true)).body.code, 'operation_id_required');
    });
    await t.test('pause and resume preserve actual offline interval and reject event reordering', async () => {
      await admin.query("UPDATE work_sessions SET started_at=now()-interval '10 minutes', updated_at=now()-interval '10 minutes', last_event_at=NULL WHERE id=$1", [workSessionId]);
      const now = Date.now(), pauseAt = new Date(now - 120000).toISOString(), resumeAt = new Date(now - 60000).toISOString();
      const pause = { invoiceId: a.invoice.id, workSessionId, reason: 'Перешёл в другое приложение', exit: true, eventAt: pauseAt, eventSequence: 1 };
      const id = randomUUID();
      const [one, two] = await Promise.all([api('POST', '/api/journal/pause', a.worker, pause, id, true), api('POST', '/api/journal/pause', a.worker, pause, id, true)]);
      must(one, 201); must(two, 201); assert.deepEqual(one.body, two.body);
      assert.equal(Date.parse(one.body.assembly.assembly.pausedAt), Date.parse(pauseAt));
      assert.equal((await api('POST', '/api/journal/pause', a.worker, { ...pause, resumed: true, eventAt: resumeAt, eventSequence: 3 }, randomUUID(), true)).body.code, 'work_event_order');
      const resumed = must(await api('POST', '/api/journal/pause', a.worker, { ...pause, exit: false, resumed: true, eventAt: resumeAt, eventSequence: 2 }, randomUUID(), true), 201);
      assert.equal(resumed.assembly.assembly.pausedMs, 60000);
      assert.equal(resumed.assembly.assembly.eventSequence, 2);
      assert.equal(resumed.assembly.assembly.status, 'active');
      assert.match(resumed.action_text, /задержкой/);
      must(await api('POST', '/api/journal/pause', a.worker, pause, id, true), 201);
      const current = must(await api('GET', `/api/receiving/session/${a.invoice.id}`, a.worker));
      assert.equal(current.assembly.status, 'active', 'replayed old pause must not pause again');
    });
    await t.test('old session events cannot change a new session for the same worker', async () => {
      must(await api('POST', `/api/receiving/session/${a.invoice.id}/abandon`, a.worker, {}));
      const next = must(await api('POST', `/api/receiving/session/${a.invoice.id}/start`, a.worker, {}), 201);
      assert.notEqual(next.assembly.id, workSessionId);
      assert.equal((await api('POST', '/api/journal/pause', a.worker, { invoiceId: a.invoice.id, workSessionId, reason: 'Запоздалая пауза', eventAt: new Date().toISOString(), eventSequence: 3 }, randomUUID(), true)).body.code, 'work_session_changed');
      assert.equal((await api('POST', placePath, a.worker, { ...placement, expected: { unplacedQty: 45 } }, randomUUID(), true)).body.code, 'work_session_changed');
      const replay = await api('POST', '/api/receiving', a.worker, receipt, receiptId, true);
      must(replay, 201); assert.equal(replay.replayed, true, 'committed command can still acknowledge after session changes');
    });
    await t.test('a saved scan is refused when addressing mode changed', async () => {
      const current = must(await api('GET', `/api/receiving/session/${a.invoice.id}`, a.worker)).assembly;
      await admin.query('UPDATE warehouses SET address_storage=false WHERE id=$1', [a.warehouseId]);
      try {
        const id = randomUUID();
        const result = await api('POST', placePath, a.worker, { ...placement, workSessionId: current.id, expected: { unplacedQty: 45 }, occurredAt: new Date().toISOString() }, id, true);
        assert.equal(result.body.code, 'addressing_changed'); assert.equal(await commandCount(id), 0);
      } finally { await admin.query('UPDATE warehouses SET address_storage=true WHERE id=$1', [a.warehouseId]); }
    });
    await t.test('retry recovers a committed placement when its response body was lost', async () => {
      const current = must(await api('GET', `/api/receiving/session/${a.invoice.id}`, a.worker)).assembly;
      const body = { ...placement, workSessionId: current.id, qty: 1, expected: { unplacedQty: 45 }, occurredAt: new Date().toISOString() };
      const id = randomUUID(), before = await stock(a.cells[1].id);
      const response = await fetch(`http://127.0.0.1:${server.address().port}${placePath}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.worker}`, 'X-Argus-Operation-Id': id, 'X-Argus-Offline': '1' },
        body: JSON.stringify(body),
      });
      await response.body.cancel(); // No result reaches the client queue.
      assert.equal(await stock(a.cells[1].id), before + 1, 'transaction committed before acknowledgement was lost');
      const recovered = await api('POST', placePath, a.worker, body, id, true);
      must(recovered, 201); assert.equal(recovered.replayed, true);
      assert.equal(await stock(a.cells[1].id), before + 1);
    });
    await t.test('partial picking with concurrent retries removes stock once', async () => {
      const invoice = must(await api('POST', '/api/invoices', a.owner, { companyId: a.companyId, number: 'ТЕСТ-ОТБОР', direction: 'out',
        items: [{ sku: 'TEST-1', name: 'Тестовый товар', declaredQty: 20 }] }), 201);
      const body = { invoiceItemId: invoice.items[0].id, cellBlockId: a.cells[0].id, pickedQty: 3, isFinal: false };
      const id = randomUUID(), before = await stock(a.cells[0].id);
      const [one, two] = await Promise.all([api('POST', '/api/shipping', a.worker, body, id), api('POST', '/api/shipping', a.worker, body, id)]);
      must(one, 201); must(two, 201); assert.deepEqual(one.body, two.body);
      assert.equal(await stock(a.cells[0].id), before - 3);
      assert.equal(Number((await admin.query('SELECT count(*) n FROM shipping_records WHERE invoice_item_id=$1', [invoice.items[0].id])).rows[0].n), 1);
    });
    await t.test('partial returns replay their result despite changed seenQty on the server', async () => {
      const invoice = must(await api('POST', '/api/invoices', a.owner, { companyId: a.companyId, number: 'ТЕСТ-ВОЗВРАТ', direction: 'return',
        items: [{ sku: 'TEST-1', name: 'Тестовый товар', declaredQty: 10 }] }), 201);
      const body = { invoiceItemId: invoice.items[0].id, cellBlockId: a.cells[0].id, qty: 2, qualityBucket: 'good', seenQty: 0 };
      const id = randomUUID(), before = await stock(a.cells[0].id);
      const one = must(await api('POST', '/api/returns', a.worker, body, id), 201);
      assert.deepEqual(must(await api('POST', '/api/returns', a.worker, body, id), 201), one);
      assert.equal(await stock(a.cells[0].id), before + 2);
    });
    await t.test('defect movement retries do not create another defect document or take more stock', async () => {
      const body = { companyId: a.companyId, sku: 'TEST-1', fromCellBlockId: a.cells[0].id, toCellBlockId: a.cells[3].id,
        qty: 2, bucket: 'defective', source: 'move', note: 'Тестовое повреждение' };
      const id = randomUUID(), before = await stock(a.cells[0].id);
      const one = must(await api('POST', '/api/defects/moves', a.worker, body, id), 201);
      assert.deepEqual(must(await api('POST', '/api/defects/moves', a.worker, body, id), 201), one);
      assert.equal(await stock(a.cells[0].id), before - 2);
      assert.equal(await stock(a.cells[3].id), 2);
    });
    await t.test('offline final placement uses confirmed work time and its later pause is a harmless acknowledgement', async () => {
      const invoice = must(await api('POST', '/api/invoices', a.owner, { companyId: a.companyId, number: 'ТЕСТ-ВРЕМЯ-ОФЛАЙН',
        items: [{ sku: 'TEST-1', name: 'Тестовый товар', declaredQty: 10 }] }), 201);
      const session = must(await api('POST', `/api/receiving/session/${invoice.id}/start`, a.worker, {}), 201).assembly;
      const now = Date.now(), startedAt = new Date(now - 600000).toISOString();
      await admin.query('UPDATE work_sessions SET started_at=$2,updated_at=$2 WHERE id=$1', [session.id, startedAt]);
      const body = { invoiceItemId: invoice.items[0].id, acceptedQty: 10, placements: [{ cellBlockId: a.cells[0].id, qty: 5, cellQr: qr1 }],
        workSessionId: session.id, expected: { received: false }, occurredAt: new Date(now - 300000).toISOString() };
      must(await api('POST', '/api/receiving', a.worker, body, randomUUID(), true), 201);
      const place = { qty: 5, cellBlockId: a.cells[1].id, cellQr: qr2, workSessionId: session.id,
        expected: { unplacedQty: 5 }, occurredAt: new Date(now - 120000).toISOString() };
      const path = `/api/receiving/items/${invoice.items[0].id}/place`, id = randomUUID();
      const finished = must(await api('POST', path, a.worker, place, id, true), 201);
      assert.equal(finished.finished.assembly.endedAt, place.occurredAt);
      assert.equal(finished.finished.assembly.workMs, 480000);
      assert.equal(finished.finished.minutes, 8);
      assert.equal((await admin.query('SELECT occurred_at FROM worker_commands WHERE operation_id=$1', [id])).rows[0].occurred_at.toISOString(), place.occurredAt);
      const paused = must(await api('POST', '/api/journal/pause', a.worker, { invoiceId: invoice.id, workSessionId: session.id,
        eventAt: new Date(now - 110000).toISOString(), eventSequence: 1, reason: 'Свернул приложение', exit: true }, randomUUID(), true));
      assert.equal(paused.ignored, 'work_finished');
      assert.equal(paused.assembly.assembly.endedAt, place.occurredAt);
      assert.deepEqual(must(await api('POST', path, a.worker, place, id, true), 201), finished);
      assert.equal((await api('POST', '/api/journal/pause', b.worker, { invoiceId: invoice.id, workSessionId: session.id,
        eventAt: new Date().toISOString(), eventSequence: 1, reason: 'Чужая пауза', exit: true }, randomUUID(), true)).body.code, 'work_session_changed');
    });
    await t.test('invalid event time never closes work or commits a command', async () => {
      const invoice = must(await api('POST', '/api/invoices', a.owner, { companyId: a.companyId, number: 'ТЕСТ-ВРЕМЯ-ОТКАЗ',
        items: [{ sku: 'TEST-1', name: 'Тестовый товар', declaredQty: 1 }] }), 201);
      const session = must(await api('POST', `/api/receiving/session/${invoice.id}/start`, a.worker, {}), 201).assembly;
      const body = { invoiceItemId: invoice.items[0].id, acceptedQty: 1, cellBlockId: a.cells[0].id, cellQr: qr1,
        workSessionId: session.id, expected: { received: false }, occurredAt: new Date(Date.now() + 120000).toISOString() };
      const id = randomUUID();
      assert.equal((await api('POST', '/api/receiving', a.worker, body, id, true)).body.code, 'work_event_time');
      assert.equal(await commandCount(id), 0);
      assert.equal(must(await api('GET', `/api/receiving/session/${invoice.id}`, a.worker)).assembly.status, 'active');
      body.occurredAt = new Date().toISOString();
      const done = must(await api('POST', '/api/receiving', a.worker, body, id, true), 201);
      assert.equal(done.finished.assembly.endedAt, body.occurredAt, 'direct final receiving uses the same event clock');
    });
    await t.test('RLS hides command results from another warehouse', async () => {
      const foreign = await withTenantContext({ warehouseId: b.warehouseId }, (c) => c.query('SELECT result FROM worker_commands WHERE operation_id=$1', [receiptId]));
      assert.equal(foreign.rowCount, 0);
      const own = await withTenantContext({ warehouseId: a.warehouseId }, (c) => c.query('SELECT result FROM worker_commands WHERE operation_id=$1', [receiptId]));
      assert.equal(own.rowCount, 1);
    });
    await t.test('schema rollback cannot silently erase acknowledgements needed by queued retries', async () => {
      const migration = require('../src/db/migrations/1754406200000_worker-commands');
      await assert.rejects(migration.down({ sql: (sql) => admin.query(sql) }), /Worker command history is in use/);
      assert.equal(await commandCount(receiptId), 1);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end(); await admin.end();
  }
});
