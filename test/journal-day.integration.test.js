// Writes only to an explicitly named disposable test database. This file
// never loads .env and skips when a dedicated test configuration is absent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const configured = process.env.ARGUS_TEST_ALLOW_WRITES === '1'
  && Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);

test('journal calendar pages, pending decisions and tenant permissions', { skip: !configured }, async (t) => {
  const database = new URL(process.env.DATABASE_URL).pathname.slice(1);
  assert.match(database, /^argus_seller_test_[a-zA-Z0-9_]+$/, 'only a disposable test database is allowed');
  assert.equal(new URL(process.env.ADMIN_DATABASE_URL).pathname.slice(1), database);
  assert.equal(new URL(process.env.DATABASE_URL).username, 'argus_app', 'API must exercise RLS as the app role');
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  const { pool } = require('../src/db/pool');
  const { createApp } = require('../src/app');
  const { signToken, passwordStamp } = require('../src/auth/service');
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ownerIds = [];
  const date = '2026-09-01';
  const api = async (token, query = '') => {
    const response = await fetch(`${base}/api/journal${query}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (token, query = '') => {
    const response = await api(token, query);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const tenant = async (zone) => {
    const owner = randomUUID(), warehouse = randomUUID(), company = randomUUID(), manager = randomUUID();
    ownerIds.push(owner);
    await admin.query('INSERT INTO owners(id,name,email,password_hash) VALUES($1,$2,$3,$4)',
      [owner, 'Journal test owner', `${owner}@example.invalid`, 'journal-fixture-password-hash']);
    await admin.query('INSERT INTO warehouses(id,owner_id,name,warehouse_code,timezone) VALUES($1,$2,$3,$4,$5)',
      [warehouse, owner, 'Journal test warehouse', `journal-${warehouse}`, zone]);
    await admin.query('INSERT INTO companies(id,warehouse_id,name) VALUES($1,$2,$3)', [company, warehouse, 'Journal test company']);
    await admin.query("INSERT INTO staff_keys(id,warehouse_id,key_code,name,kind,permissions) VALUES($1,$2,$3,$4,'manager','{}')",
      [manager, warehouse, `manager-${manager}`, 'Journal test manager']);
    return {
      warehouse, owner, company,
      token: signToken({ role: 'owner', ownerId: owner, warehouseId: warehouse, pv: passwordStamp('journal-fixture-password-hash') }),
      manager: signToken({ role: 'manager', warehouseId: warehouse, staffKeyId: manager }),
    };
  };
  const entry = async (tenant, label, at, fields = {}) => {
    const id = randomUUID();
    await admin.query(`INSERT INTO journal_entries
      (id,warehouse_id,agent,action_text,actor_type,entity_type,status,urgent,created_at,related_entry_id,cell_block_id,invoice_id)
      VALUES($1,$2,'Кладовщик',$3,'owner',$4,$5,$6,$7,$8,$9,$10)`,
    [id, tenant.warehouse, label, fields.type || 'product', fields.status || 'auto', fields.urgent || false,
      at, fields.related || null, fields.cell || null, fields.invoice || null]);
    return id;
  };
  const traverse = async (token, kind, extra = '') => {
    const rows = [], cursors = new Set();
    let cursor = null;
    do {
      const page = await ok(token, `?date=${date}&limit=17${extra}${cursor ? `&${kind === 'history' ? 'cursor' : 'pendingCursor'}=${cursor}` : ''}`);
      assert.equal(page.date, date);
      assert.equal(page.timezone, 'Asia/Novosibirsk');
      rows.push(...page[kind === 'history' ? 'entries' : 'pending']);
      cursor = page[kind === 'history' ? 'nextCursor' : 'pendingNextCursor'];
      if (cursor) {
        assert.ok(!cursors.has(cursor), 'pagination must advance');
        cursors.add(cursor);
      }
      assert.ok(cursors.size < 100, 'pagination must terminate');
    } while (cursor);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'no duplicate entries across pages');
    return rows;
  };

  try {
    const a = await tenant('Asia/Novosibirsk'), b = await tenant('Europe/Moscow');
    // More than 200 newer events must not conceal the selected older day.
    await admin.query(`INSERT INTO journal_entries(warehouse_id,agent,action_text,actor_type,entity_type,created_at)
      SELECT $1,'Кладовщик','recent-'||n,'owner','product','2026-10-03 08:00:00+00'::timestamptz + n*interval '1 second'
        FROM generate_series(1,210) n`, [a.warehouse]);
    // Transaction-era ties exercise both the final-step priority and UUID tie-breaker.
    const tied = (await admin.query(`INSERT INTO journal_entries(warehouse_id,agent,action_text,actor_type,entity_type,created_at)
      SELECT $1,'Кладовщик','tie-'||n,'owner',CASE WHEN n%2=0 THEN 'receiving_session' ELSE 'product' END,
             '2026-09-01 08:00:00+00'::timestamptz
        FROM generate_series(1,205) n RETURNING id,entity_type`, [a.warehouse])).rows;
    const micros = [];
    for (const fraction of ['123457', '123456', '123455']) {
      micros.push(await entry(a, `micro-${fraction}`, `2026-09-01 08:00:00.${fraction}+00`));
    }
    const midnight = await entry(a, 'start-of-local-day', '2026-08-31 17:00:00+00');
    const last = await entry(a, 'last-in-local-day', '2026-09-01 16:59:59.999999+00');
    const outside = [
      await entry(a, 'before-local-day', '2026-08-31 16:59:59.999999+00'),
      await entry(a, 'after-local-day', '2026-09-01 17:00:00+00'),
      await entry(b, 'other-tenant', '2026-09-01 08:00:00+00'),
    ];
    await admin.query(`INSERT INTO journal_entries(warehouse_id,agent,action_text,actor_type,entity_type,status,created_at)
      SELECT $1,'Кладовщик','pending-'||n,'worker','item_note','pending',
             '2026-08-01 08:00:00+00'::timestamptz + n*interval '1 second'
        FROM generate_series(1,105) n`, [a.warehouse]);
    const urgent = await entry(a, 'urgent-shortage', '2026-08-01 09:00:00+00', { status: 'pending', urgent: true, type: 'invoice_item' });
    const transfer = await entry(a, 'seller-transfer', '2026-08-01 09:01:00+00', { status: 'pending', urgent: true, type: 'vw_transfer' });
    const waitingToday = await entry(a, 'pending-within-selected-day', '2026-09-01 08:01:00+00', { status: 'pending', type: 'item_note' });
    const answered = await entry(a, 'answered-note', '2026-09-01 08:02:00+00', { status: 'pending', type: 'item_note' });
    const answer = await entry(a, 'acknowledged-note', '2026-09-01 08:03:00+00', { status: 'confirmed', type: 'item_note', related: answered });
    const otherPending = await entry(b, 'other-tenant-pending', '2026-08-01 09:00:00+00', { status: 'pending', type: 'item_note' });

    await t.test('old day and warehouse midnight are selected before pagination', async () => {
      const history = await traverse(a.token, 'history');
      assert.equal(history.length, tied.length + micros.length + 4);
      const ids = new Set(history.map((row) => row.id));
      for (const id of [midnight, last, answered, answer]) assert.ok(ids.has(id));
      for (const id of [...outside, waitingToday, urgent, transfer, otherPending]) assert.ok(!ids.has(id));
      assert.equal(history[0].id, last);
      assert.deepEqual(history.slice(1, 4).map((row) => row.id), [answer, answered, micros[0]]);
      const microPage = await ok(a.token, `?date=${date}&limit=4`);
      assert.match(JSON.parse(Buffer.from(microPage.nextCursor, 'base64url').toString()).at, /\.123457/);
      const afterMicro = await ok(a.token, `?date=${date}&limit=1&cursor=${microPage.nextCursor}`);
      assert.equal(afterMicro.entries[0].id, micros[1]);
      assert.deepEqual(history.filter((row) => row.action_text.startsWith('micro-')).map((row) => row.id), micros);
      const atSameTime = history.filter((row) => row.action_text.startsWith('tie-'));
      assert.ok(atSameTime.slice(0, 102).every((row) => row.entity_type === 'receiving_session'));
      assert.ok(atSameTime.slice(102).every((row) => row.entity_type === 'product'));
      for (const group of [atSameTime.slice(0, 102), atSameTime.slice(102)]) {
        assert.deepEqual(group.map((row) => row.id), group.map((row) => row.id).sort().reverse());
      }
      assert.ok(history.every((row) => row.category && row.work === null));
      const legacy = await ok(a.token);
      assert.ok(Array.isArray(legacy));
      assert.ok(!legacy.some((row) => tied.some((old) => old.id === row.id)));
      assert.ok(legacy.some((row) => row.id === urgent), 'legacy always includes old urgent pending entries');
    });

    await t.test('pending pages remain available outside date and category and do not duplicate history', async () => {
      const pending = await traverse(a.token, 'pending');
      assert.equal(pending.length, 108);
      for (const id of [waitingToday, urgent, transfer]) assert.ok(pending.some((row) => row.id === id));
      assert.ok(!pending.some((row) => [answered, answer, otherPending].includes(row.id)));
      const emptyDay = await ok(a.token, '?date=2024-02-29&category=docs');
      assert.equal(emptyDay.entries.length, 0);
      assert.equal(emptyDay.pending.length, 100);
      assert.ok(emptyDay.pendingNextCursor);
    });

    await t.test('manager restrictions, seller/worker denial and foreign cursors', async () => {
      const managerPending = await traverse(a.manager, 'pending');
      assert.ok(!managerPending.some((row) => row.id === urgent));
      assert.ok(managerPending.some((row) => row.id === transfer));
      const first = await ok(a.token, `?date=${date}&limit=1`);
      assert.equal((await api(b.token, `?date=${date}&cursor=${first.nextCursor}`)).status, 400);
      assert.equal((await api(a.manager, `?date=${date}&cursor=${first.nextCursor}`)).status, 400);
      assert.equal((await api(a.token, `?date=2026-09-02&cursor=${first.nextCursor}`)).status, 400);
      assert.equal((await api(a.token, `?date=${date}&pendingCursor=${first.nextCursor}`)).status, 400);
      for (const role of ['seller', 'worker']) {
        assert.equal((await api(signToken({ role, warehouseId: a.warehouse }), `?date=${date}`)).status, 403);
      }
      assert.equal((await api(a.token, '?date=2026-02-30')).status, 400);
      assert.equal((await api(a.token, `?date=${date}&limit=101`)).status, 400);
      assert.equal((await api(a.token, `?date=${date}&cursor=bad*`)).status, 400);
    });

    await t.test('cell and invoice scopes retain the one-year cell restriction', async () => {
      const rowId = randomUUID(), cell = randomUUID(), invoice = randomUUID();
      await admin.query('INSERT INTO warehouse_rows(id,warehouse_id,row_num,rack_count,tier_count) VALUES($1,$2,1,1,1)', [rowId, a.warehouse]);
      await admin.query(`INSERT INTO cell_blocks(id,warehouse_row_id,warehouse_id,rack_start,rack_end,tier_start,tier_end)
        VALUES($1,$2,$3,1,1,1,1)`, [cell, rowId, a.warehouse]);
      await admin.query('INSERT INTO invoices(id,warehouse_id,company_id,number) VALUES($1,$2,$3,$4)',
        [invoice, a.warehouse, a.company, `journal-${invoice}`]);
      const scoped = await entry(a, 'scoped-event', '2026-09-01 09:00:00+00', { cell, invoice });
      const oldScoped = await entry(a, 'old-cell-event', '2024-02-29 09:00:00+00', { cell, invoice });
      for (const query of [`cellBlockId=${cell}`, `invoiceId=${invoice}`]) {
        const page = await ok(a.token, `?date=${date}&${query}`);
        assert.deepEqual(page.entries.map((row) => row.id), [scoped]);
      }
      const scopedOld = await ok(a.token, `?date=2024-02-29&cellBlockId=${cell}`);
      assert.equal(scopedOld.entries.length, 0);
      const globalOld = await ok(a.token, '?date=2024-02-29');
      assert.ok(globalOld.entries.some((row) => row.id === oldScoped));
      const legacyCell = await ok(a.token, `?cellBlockId=${cell}`);
      assert.ok(legacyCell.some((row) => row.id === scoped));
      assert.ok(!legacyCell.some((row) => row.id === oldScoped));
      const foreignScope = await ok(b.token, `?date=${date}&invoiceId=${invoice}`);
      assert.equal(foreignScope.entries.length, 0);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    if (ownerIds.length) await admin.query('DELETE FROM owners WHERE id = ANY($1::uuid[])', [ownerIds]);
    await admin.end();
  }
});
