// Склад брака продавца (владелец 02.10.2026): откуда брак попадает на склад
// брака (приёмка, сборка, возврат вручную, перекладка, загрузка остатков),
// фото, решение продавца и склада за продавца, уведомление, задания грузчику,
// их выполнение, акты, ячейки брака, напоминание. Только на отдельной
// тестовой базе.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const rules = require('../src/alerts/rules');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, token, body, headers = {}) {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(base + path, { method, headers: {
      ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
    }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  const api = async (method, path, token, body, status = 200, headers) => {
    const r = await call(method, path, token, body, headers);
    assert.equal(r.status, status, `${method} ${path}: ${r.status} ${r.body && r.body.error || ''}`);
    return r.body;
  };
  let passed = 0;
  const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
  try {
    const owner = (await api('POST', '/api/auth/owner/register', null, {
      name: 'Брак', email: `defects-${Date.now()}@example.test`, password: 'test-only-password', warehouseName: 'Брак', city: 'Test',
    }, 201)).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const db = (sql, args) => withTenantContext({ warehouseId }, (c) => c.query(sql, args));
    const a = await api('POST', '/api/sellers/companies', owner, { name: 'Брак А' }, 201);
    const b = await api('POST', '/api/sellers/companies', owner, { name: 'Брак Б' }, 201);
    const seller = async (company) => {
      const key = await api('POST', `/api/sellers/companies/${company.id}/keys`, owner, {}, 201);
      return (await api('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Продавец' })).token;
    };
    const sa = await seller(a); const sb = await seller(b);
    const wk = await api('POST', '/api/staff', owner, { name: 'Грузчик' }, 201);
    const worker = (await api('POST', '/api/auth/staff/login', null, { keyCode: wk.key_code })).token;
    await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 6, tierCount: 1 }] }, 201);
    const cells = (await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks).map((x) => x.id);
    await db(`INSERT INTO products (warehouse_id, company_id, sku, name, barcode) VALUES
      ($1, $2, 'BR-1', 'Ведро мармелада', '4600000000011'), ($1, $2, 'BR-2', 'Сгущенка', '4600000000028'),
      ($1, $2, 'BR-3', 'Пастила', '4600000000035')`, [warehouseId, a.id]);
    const stock = async (cell, sku, quality) => Number((await db(
      'SELECT COALESCE(SUM(qty), 0) AS n FROM cell_stock WHERE cell_block_id = $1 AND sku = $2 AND quality = $3',
      [cell, sku, quality])).rows[0].n);

    // --- Приёмка: часть принятого — брак ---
    const inv = await api('POST', '/api/invoices', owner, { companyId: a.id, number: 'ПР-БРАК', items: [
      { sku: 'BR-1', name: 'Ведро мармелада', declaredQty: 10 }, { sku: 'BR-2', name: 'Сгущенка', declaredQty: 3 },
      { sku: 'BR-3', name: 'Пастила', declaredQty: 10 }] }, 201);
    await api('POST', `/api/receiving/session/${inv.id}/start`, worker, {}, 201);
    const [i1, i2, i3] = inv.items;
    const r1 = await api('POST', '/api/receiving', worker, { invoiceItemId: i1.id, acceptedQty: 10,
      placements: [{ cellBlockId: cells[0], qty: 8 }], defect: { qty: 2, bucket: 'defective', note: 'треснула крышка', cellBlockId: cells[5] } }, 201);
    assert.equal(r1.unplaced, 0); assert.equal(r1.defects[0].qty, 2);
    assert.deepEqual([await stock(cells[0], 'BR-1', 'good'), await stock(cells[5], 'BR-1', 'defective')], [8, 2]);
    // Всё принятое — брак: годного раскладывать нечего.
    const r2 = await api('POST', '/api/receiving', worker, { invoiceItemId: i2.id, acceptedQty: 3,
      defect: { qty: 3, bucket: 'packaging_defect', cellBlockId: cells[5] } }, 201);
    assert.equal(r2.unplaced, 0);
    await api('POST', '/api/receiving', worker, { invoiceItemId: i3.id, acceptedQty: 10,
      defect: { qty: 11, bucket: 'defective', cellBlockId: cells[5] } }, 400);
    await api('POST', '/api/receiving', worker, { invoiceItemId: i3.id, acceptedQty: 10, placements: [{ cellBlockId: cells[1], qty: 7 }] }, 201);
    // Позже, из «осталось разложить», — кнопкой «Брак».
    await api('POST', `/api/receiving/items/${i3.id}/defect`, worker, { qty: 4, bucket: 'defective', cellBlockId: cells[5] }, 400);
    const r3 = await api('POST', `/api/receiving/items/${i3.id}/defect`, worker, { qty: 3, bucket: 'defective', note: 'мятая', cellBlockId: cells[5] }, 201);
    assert.equal(r3.unplaced, 0); assert.equal(r3.invoiceStatus, 'completed');
    // «Переложить» и «Убрать» брака не касаются: в ячейке брака годного этой приёмки нет.
    const moves1 = (await db("SELECT source, qty::int, bucket FROM defect_moves WHERE company_id = $1 ORDER BY number", [a.id])).rows;
    assert.deepEqual(moves1.map((m) => [m.source, m.qty, m.bucket]),
      [['receiving', 2, 'defective'], ['receiving', 3, 'packaging_defect'], ['receiving', 3, 'defective']]);
    check('receiving: defect part goes to the defect cell, all-defect accepted, later «Брак» from the unplaced rest');

    // «Брак» до раскладки: годное остаётся разложить.
    const inv2 = await api('POST', '/api/invoices', owner, { companyId: a.id, number: 'ПР-БРАК-2', items: [
      { sku: 'BR-3', name: 'Пастила', declaredQty: 5 }] }, 201);
    await api('POST', `/api/receiving/session/${inv2.id}/start`, worker, {}, 201);
    const r4 = await api('POST', '/api/receiving', worker, { invoiceItemId: inv2.items[0].id, acceptedQty: 5,
      defect: { qty: 1, bucket: 'defective', cellBlockId: cells[5] } }, 201);
    assert.equal(r4.unplaced, 4);
    const r5 = await api('POST', `/api/receiving/items/${inv2.items[0].id}/place`, worker, { cellBlockId: cells[1], qty: 4 }, 201);
    assert.equal(r5.invoiceStatus, 'completed');
    check('receiving: «Брак» before placing leaves the good rest to place');

    // --- Сборка: брак на полке среди годного ---
    await api('POST', '/api/defects/moves', worker, { companyId: a.id, sku: 'BR-1', fromCellBlockId: cells[0], toCellBlockId: cells[5],
      qty: 9, bucket: 'defective' }, 409);
    const pm = await api('POST', '/api/defects/moves', worker, { companyId: a.id, sku: 'BR-1', fromCellBlockId: cells[0], toCellBlockId: cells[5],
      qty: 1, bucket: 'defective', note: 'вмятина', source: 'picking' }, 201);
    assert.match(pm.number, /^БР-\d{6}-\d+$/);
    assert.deepEqual([await stock(cells[0], 'BR-1', 'good'), await stock(cells[5], 'BR-1', 'defective')], [7, 3]);
    await api('POST', '/api/defects/moves', worker, { companyId: b.id, sku: 'BR-1', fromCellBlockId: cells[0], qty: 1, bucket: 'defective' }, 409);
    check('picking: good unit becomes defect in the defect cell; another seller cannot touch it');

    // --- Возврат вручную ---
    const ret = await api('POST', '/api/returns/manual', worker, { companyId: a.id, items: [{ sku: 'BR-2', qty: 2 }] }, 201);
    assert.match(ret.number, /^ВЗ-\d{6}-\d+$/);
    await api('POST', '/api/returns/manual', worker, { companyId: a.id, items: [{ sku: 'NOPE', qty: 1 }] }, 400);
    const listed = (await api('GET', '/api/invoices?direction=return', worker)).find((r) => r.id === ret.id);
    assert.ok(listed, 'worker sees the manual return');
    const retItem = (await api('GET', `/api/invoices/${ret.id}`, worker)).items[0];
    await api('POST', '/api/returns', worker, { invoiceItemId: retItem.id, qty: 1, qualityBucket: 'good', cellBlockId: cells[2] }, 201);
    await api('POST', '/api/returns', worker, { invoiceItemId: retItem.id, qty: 1, qualityBucket: 'defective' }, 400);
    const rd = await api('POST', '/api/returns', worker, { invoiceItemId: retItem.id, qty: 1, qualityBucket: 'defective',
      cellBlockId: cells[5], defectNote: 'вздулась банка' }, 201);
    assert.ok(rd.move && rd.move.number);
    check('manual return: worker creates it, sorts it; defect needs a cell and becomes a defect document');

    // --- Фото ---
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9]);
    await api('PUT', `/api/defects/moves/${pm.id}/photo`, worker, Buffer.from('MZ'), 400, { 'Content-Type': 'application/x-msdownload' });
    await api('PUT', `/api/defects/moves/${pm.id}/photo`, worker, jpeg, 200, { 'Content-Type': 'image/jpeg' });
    const got = await call('GET', `/api/defects/moves/${pm.id}/photo`, sa);
    assert.equal(got.status, 200); assert.deepEqual(got.body, jpeg);
    await api('GET', `/api/defects/moves/${pm.id}/photo`, sb, undefined, 404);
    check('photo: worker attaches, own seller sees it, other seller does not');

    // --- Кабинет продавца: склад брака ---
    let view = await api('GET', '/api/sellers/defects', sa);
    const bal = (sku, bucket) => view.balances.find((x) => x.sku === sku && x.bucket === bucket);
    assert.equal(bal('BR-1', 'defective').qty, 3); assert.equal(bal('BR-1', 'defective').undecided, 3);
    assert.equal(bal('BR-2', 'packaging_defect').qty, 3); assert.equal(bal('BR-2', 'defective').qty, 1);
    assert.equal(view.moves.find((m) => m.id === pm.id).hasPhoto, true);
    assert.deepEqual((await api('GET', '/api/sellers/defects', sb)).balances, []);
    check('seller sees his defect warehouse: balances, undecided, documents with photo flag; other seller sees nothing');

    // --- Решения ---
    await api('POST', '/api/sellers/defects/decisions', sa, { sku: 'BR-1', bucket: 'defective', qty: 4, action: 'dispose' }, 409);
    await api('POST', '/api/sellers/defects/decisions', sa, { sku: 'BR-1', bucket: 'defective', qty: 1, action: 'markdown' }, 400);
    await api('POST', '/api/sellers/defects/decisions', sb, { sku: 'BR-1', bucket: 'defective', qty: 1, action: 'dispose' }, 409);
    const dDispose = await api('POST', '/api/sellers/defects/decisions', sa, { sku: 'BR-1', bucket: 'defective', qty: 1, action: 'dispose' }, 201);
    const dReturn = await api('POST', '/api/sellers/defects/decisions', owner,
      { companyId: a.id, sku: 'BR-1', bucket: 'defective', qty: 1, action: 'return_to_seller', note: 'по звонку' }, 201);
    const dRepack = await api('POST', '/api/sellers/defects/decisions', sa, { sku: 'BR-2', bucket: 'packaging_defect', qty: 2, action: 'repack' }, 201);
    const dMark = await api('POST', '/api/sellers/defects/decisions', sa,
      { sku: 'BR-1', bucket: 'defective', qty: 1, action: 'markdown', markdownBarcode: '2040000000017' }, 201);
    await api('POST', '/api/sellers/defects/decisions', sa, { sku: 'BR-1', bucket: 'defective', qty: 1, action: 'dispose' }, 409);
    view = await api('GET', '/api/sellers/defects', sa);
    assert.equal(bal('BR-1', 'defective').undecided, 0);
    const unseen = view.decisions.filter((d) => d.unseen).map((d) => d.number);
    assert.deepEqual(unseen, [dReturn.number]);
    assert.equal(view.decisions.find((d) => d.number === dReturn.number).decidedName, 'Руководитель склада');
    await api('POST', '/api/sellers/defects/seen', sa, {}, 200);
    view = await api('GET', '/api/sellers/defects', sa);
    assert.equal(view.decisions.filter((d) => d.unseen).length, 0);
    check('decisions: seller decides within the undecided amount; warehouse decides on behalf and seller is notified until seen');

    // --- Задания грузчику ---
    const tasks = await api('GET', '/api/defects/tasks', worker);
    assert.equal(tasks.length, 4);
    assert.deepEqual(tasks.find((t) => t.id === dDispose.id).cells.map((c) => c.qty), [3]);
    await api('POST', `/api/defects/tasks/${dDispose.id}/done`, worker, {}, 200);
    await api('POST', `/api/defects/tasks/${dDispose.id}/done`, worker, {}, 409);
    await api('POST', `/api/defects/tasks/${dReturn.id}/done`, worker, {}, 200);
    await api('POST', `/api/defects/tasks/${dRepack.id}/done`, worker, {}, 400);
    await api('POST', `/api/defects/tasks/${dRepack.id}/done`, worker, { cellBlockId: cells[3] }, 200);
    const mk = await api('POST', `/api/defects/tasks/${dMark.id}/done`, worker, { cellBlockId: cells[4] }, 200);
    assert.equal(mk.toSku, 'УЦ-2040000000017');
    assert.deepEqual([await stock(cells[5], 'BR-1', 'defective'), await stock(cells[3], 'BR-2', 'good'),
      await stock(cells[4], 'УЦ-2040000000017', 'good'), await stock(cells[5], 'BR-2', 'packaging_defect')], [0, 2, 1, 1]);
    const mdp = (await db("SELECT name, barcode FROM products WHERE company_id = $1 AND sku = 'УЦ-2040000000017'", [a.id])).rows[0];
    assert.deepEqual(mdp, { name: 'Ведро мармелада — уценка', barcode: '2040000000017' });
    assert.equal((await api('GET', '/api/defects/tasks', worker)).length, 0);
    check('worker tasks: dispose and return take defect from cells, repack and markdown put good stock (markdown as a new product)');

    // --- Акты ---
    const act = await api('GET', `/api/acts/defect/${dDispose.id}`, sa);
    assert.equal(act.action, 'dispose'); assert.equal(act.items[0].qty, 1); assert.equal(act.finished, true);
    await api('GET', `/api/acts/defect/${dDispose.id}`, sb, undefined, 404);
    await api('GET', `/api/acts/defect/${dRepack.id}`, owner, undefined, 400);
    check('acts: disposal and return acts for own seller only');

    // --- Ячейки брака и подсказки ---
    await api('PATCH', `/api/defects/zones/${cells[2]}`, worker, { on: true }, 403);
    await api('PATCH', `/api/defects/zones/${cells[2]}`, owner, { on: true }, 200);
    const sugg = await api('GET', `/api/defects/cells?companyId=${a.id}`, worker);
    assert.equal(sugg[0].cellBlockId, cells[5]); assert.equal(sugg[1].cellBlockId, cells[2]); assert.equal(sugg[1].reason, 'ячейка брака');
    check('defect cells: own defect cells first, then cells marked by the owner, then empty');

    // --- Перекладка годного в брак ---
    await api('POST', '/api/cells/move', worker, { sku: 'BR-3', fromCellBlockId: cells[1], toQuality: 'defective', qty: 1 }, 400);
    await api('POST', '/api/cells/move', worker, { sku: 'BR-3', companyId: a.id, fromCellBlockId: cells[1], toCellBlockId: cells[5],
      toQuality: 'defective', qty: 1 }, 201);
    assert.equal((await db("SELECT count(*)::int AS n FROM defect_moves WHERE company_id = $1 AND source = 'move'", [a.id])).rows[0].n, 1);
    check('worker move good → defect creates a defect document');

    // --- Загрузка остатков с браком и её отмена ---
    const rows = [{ cell: '1.2.1', sku: 'BR-1', qty: 5 }, { cell: '1.2.1', sku: 'BR-1', qty: 2, quality: 'брак' }];
    const planned = await api('POST', '/api/cells/initial-stock', owner, { companyId: a.id, rows }, 200);
    const applied = await api('POST', '/api/cells/initial-stock', owner, { companyId: a.id, rows, apply: true,
      expect: { ok: planned.summary.ok, units: planned.summary.units } }, 200);
    assert.equal(applied.applied, true, JSON.stringify(applied).slice(0, 300));
    const loadMoves = (await db("SELECT qty::int, batch FROM defect_moves WHERE company_id = $1 AND source = 'initial_load'", [a.id])).rows;
    assert.deepEqual(loadMoves.map((m) => m.qty), [2]);
    view = await api('GET', '/api/sellers/defects', sa);
    assert.ok(view.moves.some((m) => m.source === 'initial_load'), 'initial-load defect is listed');
    await api('POST', `/api/cells/initial-stock/batches/${loadMoves[0].batch}/undo`, owner, {}, 200);
    assert.equal((await db("SELECT count(*)::int AS n FROM defect_moves WHERE company_id = $1 AND source = 'initial_load'", [a.id])).rows[0].n, 0);
    check('initial load: defect lines become defect documents; undo removes them');

    // --- Напоминание: брак ждёт решения неделю ---
    await db("UPDATE defect_moves SET created_at = now() - interval '9 days' WHERE company_id = $1", [a.id]);
    const found = await withTenantContext({ warehouseId }, (c) => rules.collect(c, warehouseId));
    const remind = found.find((f) => f.key === `defect_waiting:${a.id}`);
    assert.ok(remind, JSON.stringify(found));
    assert.match(remind.text, /Брак А.*9 дней/);
    check('reminder: undecided defect older than a week is reported per seller');

    // --- Журнал: категория «Брак» ---
    const journalRows = await api('GET', '/api/journal', owner);
    const flat = journalRows.flatMap((e) => [e, ...(e.children || [])]);
    assert.ok(flat.some((e) => e.entity_type === 'defect_decision' && e.category === 'defects'));
    check('journal: defect events are in the «Брак» category');

    console.log(`\n${passed} checks passed`);
  } finally {
    await new Promise((r) => server.close(r)); await pool.end();
  }
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
