// Execute only with an explicitly named disposable database.
// Привоз по логике фулфилмента (владелец 26.09.2026): окно выгрузки и
// грузоместа, новый товар из файла, правка и отмена до приезда машины,
// «машина приехала», документы поставщика, переписка, ответ на акт.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, token, body, headers = {}) {
    const raw = Buffer.isBuffer(body);
    const response = await fetch(base + path, { method, headers: {
      ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
    }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()), type };
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
      name: 'Test owner', email: `inbound-log-${Date.now()}@example.test`, password: 'test-only-password',
      warehouseName: 'Inbound logistics', city: 'Test',
    }, 201)).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const a = await api('POST', '/api/sellers/companies', owner, { name: 'Привоз А' }, 201);
    const b = await api('POST', '/api/sellers/companies', owner, { name: 'Привоз Б' }, 201);
    const seller = async (company) => {
      const key = await api('POST', `/api/sellers/companies/${company.id}/keys`, owner, {}, 201);
      return (await api('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Test seller' })).token;
    };
    const sa = await seller(a); const sb = await seller(b);
    const workerKey = await api('POST', '/api/staff', owner, { name: 'Грузчик' }, 201);
    const worker = (await api('POST', '/api/auth/staff/login', null, { keyCode: workerKey.key_code })).token;
    await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 2, tierCount: 1 }] }, 201);
    const cell = (await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks)[0].id;
    const db = (sql, args) => withTenantContext({ warehouseId }, (c) => c.query(sql, args));
    await db(`INSERT INTO products (warehouse_id, company_id, sku, name, barcode) VALUES
      ($1, $2, 'LG-1', 'Футболка', '4600000000011'), ($1, $2, 'LG-2', 'Шорты', '4600000000028')`, [warehouseId, a.id]);
    const journalOf = async (invoiceId) => (await db('SELECT action_text, status FROM journal_entries WHERE invoice_id = $1 ORDER BY created_at, id', [invoiceId])).rows;

    // 1 и 5. Окно выгрузки и грузоместа.
    const grid = [['Баркод', 'Количество'], ['4600000000011', 10], ['4600000000028', 4]];
    const details = { plannedDate: '2026-10-01', plannedFrom: '10:00', plannedTo: '12:00', boxes: 5, pallets: 1, weightKg: 120.5, carrier: 'ТК', vehicle: 'А123ВС' };
    await api('POST', '/api/sellers/inbound', sa, { grid, apply: true, ...details, plannedFrom: '12:00', plannedTo: '10:00' }, 400);
    await api('POST', '/api/sellers/inbound', sa, { grid, apply: true, ...details, boxes: -1 }, 400);
    await api('POST', '/api/sellers/inbound', sa, { grid, apply: true, ...details, plannedFrom: '25:00' }, 400);
    const one = (await api('POST', '/api/sellers/inbound', sa, { grid, apply: true, ...details })).invoice;
    let card = await api('GET', `/api/inbound/${one.id}`, sa);
    assert.deepEqual([card.plannedDate, card.plannedFrom, card.plannedTo, card.boxes, card.pallets, card.weightKg], ['2026-10-01', '10:00', '12:00', 5, 1, 120.5]);
    assert.equal(card.editable, true);
    assert.match((await journalOf(one.id))[0].action_text, /01\.10\.2026 с 10:00 до 12:00.*5 коробов, 1 паллета, 120\.5 кг/);
    const listed = (await api('GET', '/api/invoices?direction=in', worker)).find((r) => r.id === one.id);
    assert.equal(listed.boxes, 5); assert.equal(String(listed.planned_from).slice(0, 5), '10:00');
    check('window and places are saved, validated, shown to worker and journal');

    // 2. Новый товар из файла.
    const fresh = [['Артикул', 'Наименование', 'Штрихкод', 'Кол-во'], ['NEW-7', 'Кепка', '4600000000035', 3], ['', 'Без артикула', '', 2], ['LG-1', 'Футболка', '', 1]];
    const preview = await api('POST', '/api/sellers/inbound', sa, { grid: fresh });
    assert.equal(preview.summary.newProducts, 1); assert.equal(preview.summary.notMatched, 1);
    assert.equal(preview.lines.find((l) => l.article === 'NEW-7').isNew, true);
    const without = (await api('POST', '/api/sellers/inbound', sa, { grid: fresh, apply: true })).invoice;
    assert.deepEqual((await api('GET', `/api/inbound/${without.id}`, sa)).lines.map((l) => l.sku), ['LG-1']);
    const withNew = await api('POST', '/api/sellers/inbound', sa, { grid: fresh, apply: true, createNew: true });
    assert.equal(withNew.created, 1);
    const product = (await db('SELECT name, barcode FROM products WHERE company_id = $1 AND sku = $2', [a.id, 'NEW-7'])).rows[0];
    assert.deepEqual(product, { name: 'Кепка', barcode: '4600000000035' });
    assert.deepEqual((await api('GET', `/api/inbound/${withNew.invoice.id}`, sa)).lines.map((l) => [l.sku, l.declared]).sort(), [['LG-1', 1], ['NEW-7', 3]]);
    assert.match((await journalOf(withNew.invoice.id))[0].action_text, /Новые товары.*«Кепка» \(NEW-7\)/);
    // Повторно — не дубль: артикул уже есть.
    assert.equal((await api('POST', '/api/sellers/inbound', sa, { grid: fresh, apply: true, createNew: true })).created, 0);
    check('unknown rows with name and article become new products only when asked, no duplicates');

    // 8. Изменить и отменить до приезда машины; чужой — не видит.
    await api('GET', `/api/inbound/${one.id}`, sb, undefined, 404);
    await api('PATCH', `/api/inbound/${one.id}`, sb, details, 404);
    await api('DELETE', `/api/inbound/${one.id}`, sb, undefined, 404);
    await api('PATCH', `/api/inbound/${one.id}`, sa, { ...details, plannedTo: '14:00', boxes: 6 });
    card = await api('GET', `/api/inbound/${one.id}`, sa);
    assert.deepEqual([card.plannedTo, card.boxes], ['14:00', 6]);
    const replaced = await api('POST', '/api/sellers/inbound', sa, { grid: [['Баркод', 'Количество'], ['4600000000011', 7]], apply: true, invoiceId: one.id, ...details, boxes: 6 });
    assert.equal(replaced.invoice.number, one.number);
    assert.deepEqual((await api('GET', `/api/inbound/${one.id}`, sa)).lines.map((l) => [l.sku, l.declared]), [['LG-1', 7]]);
    const cancel = (await api('POST', '/api/sellers/inbound', sa, { grid, apply: true })).invoice;
    await api('DELETE', `/api/inbound/${cancel.id}`, sa);
    await api('GET', `/api/inbound/${cancel.id}`, sa, undefined, 404);
    assert.equal((await db(`SELECT count(*)::int AS n FROM journal_entries WHERE action_text LIKE $1`, [`%отменил привоз ${cancel.number}%`])).rows[0].n, 1);
    // Номер отменённого не выдаётся снова.
    const next = (await api('POST', '/api/sellers/inbound', sa, { grid, apply: true })).invoice;
    assert.notEqual(next.number, cancel.number);
    await api('DELETE', `/api/inbound/${next.id}`, sa);
    const byWarehouse = await api('POST', '/api/invoices', owner, { companyId: a.id, number: 'СКЛ-1', items: [{ sku: 'LG-1', name: 'Футболка', declaredQty: 1 }] }, 201);
    await api('DELETE', `/api/inbound/${byWarehouse.id}`, sa, undefined, 409);
    check('seller edits, replaces goods and cancels own inbound before arrival; other seller 404; warehouse receipt untouchable');

    // 9. Машина приехала — отмечает склад; после этого менять поздно.
    await api('POST', `/api/inbound/${one.id}/arrived`, sa, { boxes: 5 }, 403);
    await api('POST', `/api/inbound/${one.id}/arrived`, worker, { boxes: 5, pallets: 1 });
    await api('POST', `/api/inbound/${one.id}/arrived`, worker, { boxes: 5 }, 409);
    const arrivedNote = (await journalOf(one.id)).find((e) => /приехала/.test(e.action_text));
    assert.equal(arrivedNote.status, 'pending'); assert.match(arrivedNote.action_text, /Мест: 5 коробов, 1 паллета.*Заявлено было: 6 коробов/);
    await api('PATCH', `/api/inbound/${one.id}`, sa, details, 409);
    await api('DELETE', `/api/inbound/${one.id}`, sa, undefined, 409);
    card = await api('GET', `/api/inbound/${one.id}`, sa);
    assert.equal(card.editable, false); assert.equal(card.arrivedBoxes, 5);
    check('arrival is marked by the warehouse once, place mismatch flagged, then edits refused');

    // 4. Документы поставщика: реквизиты и файл.
    const doc = await api('POST', `/api/inbound/${one.id}/documents`, sa, { kind: 'УПД', number: '123', date: '2026-09-25', supplier: 'ООО Поставщик' }, 201);
    await api('POST', `/api/inbound/${one.id}/documents`, sa, { kind: '' }, 400);
    await api('POST', `/api/inbound/${one.id}/documents`, sb, { kind: 'УПД' }, 404);
    const pdf = Buffer.from('%PDF-1.4 test document');
    await api('PUT', `/api/inbound/${one.id}/documents/${doc.id}/file`, sa, Buffer.from('MZ'), 400, { 'Content-Type': 'application/x-msdownload' });
    await api('PUT', `/api/inbound/${one.id}/documents/${doc.id}/file`, sa, Buffer.alloc(11 * 1024 * 1024), 413, { 'Content-Type': 'application/pdf' });
    await api('PUT', `/api/inbound/${one.id}/documents/${doc.id}/file`, sa, pdf, 200, { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('УПД 123.pdf') });
    const got = await call('GET', `/api/inbound/${one.id}/documents/${doc.id}/file`, owner);
    assert.equal(got.status, 200); assert.equal(got.type, 'application/pdf'); assert.deepEqual(got.body, pdf);
    await api('GET', `/api/inbound/${one.id}/documents/${doc.id}/file`, sb, undefined, 404);
    await api('GET', `/api/inbound/${one.id}/documents/${doc.id}/file`, worker, undefined, 403);
    card = await api('GET', `/api/inbound/${one.id}`, sa);
    assert.deepEqual([card.documents[0].kind, card.documents[0].number, card.documents[0].date, card.documents[0].fileName], ['УПД', '123', '25.09.2026', 'УПД 123.pdf']);
    const whDoc = await api('POST', `/api/inbound/${one.id}/documents`, owner, { kind: 'ТТН' }, 201);
    await api('DELETE', `/api/inbound/${one.id}/documents/${whDoc.id}`, sa, undefined, 403);
    check('supplier documents: details, PDF upload and download, type and size limits, isolation');

    // 7. Переписка: продавец пишет — отметка ждёт склада; ответ её закрывает.
    await api('POST', `/api/inbound/${one.id}/comments`, sa, { body: 'В УПД нет кода товара', sku: 'LG-1' }, 201);
    await api('POST', `/api/inbound/${one.id}/comments`, sa, { body: 'x', sku: 'NOPE' }, 400);
    await api('POST', `/api/inbound/${one.id}/comments`, worker, { body: 'привет' }, 403);
    await api('POST', `/api/inbound/${one.id}/comments`, sb, { body: 'чужой' }, 404);
    const pendingComment = await db(`SELECT id FROM journal_entries WHERE invoice_id = $1 AND entity_type = 'invoice_comment' AND status = 'pending'`, [one.id]);
    assert.equal(pendingComment.rows.length, 1);
    await api('POST', `/api/inbound/${one.id}/comments`, owner, { body: 'Добавим код в акт' }, 201);
    const answered = await db('SELECT count(*)::int AS n FROM journal_entries WHERE related_entry_id = $1', [pendingComment.rows[0].id]);
    assert.equal(answered.rows[0].n, 1);
    card = await api('GET', `/api/inbound/${one.id}`, sa);
    assert.deepEqual(card.comments.map((m) => [m.authorRole, m.productName]), [['seller', 'Футболка'], ['owner', null]]);
    assert.deepEqual((await api('GET', `/api/inbound/${one.id}`, worker)).comments, []);
    check('comments: seller to warehouse per line, reply resolves the journal mark, no chat for worker');

    // 7. Акт расхождений: ответ продавца — когда приход принят, один раз.
    await api('POST', `/api/inbound/${one.id}/verdict`, sa, { verdict: 'agreed' }, 409);
    const inv = await api('GET', `/api/invoices/${one.id}`, worker);
    await api('POST', '/api/receiving', worker, { invoiceItemId: inv.items[0].id, acceptedQty: 5, cellBlockId: null }, 201);
    card = await api('GET', `/api/inbound/${one.id}`, sa);
    assert.deepEqual([card.discrepancy, card.unplaced], [-2, 5]);
    const docs = (await api('GET', '/api/sellers/documents', sa)).rows.find((r) => r.id === one.id);
    assert.equal(Number(docs.unplaced_qty), 5); assert.equal(docs.comment_count, 2); assert.equal(docs.document_count, 2);
    await api('POST', `/api/inbound/${one.id}/verdict`, owner, { verdict: 'agreed' }, 403);
    await api('POST', `/api/inbound/${one.id}/verdict`, sa, { verdict: 'disputed' }, 400);
    await api('POST', `/api/inbound/${one.id}/verdict`, sa, { verdict: 'disputed', note: 'Отгружали 7, есть видео' });
    await api('POST', `/api/inbound/${one.id}/verdict`, sa, { verdict: 'agreed' }, 409);
    const verdictNote = (await journalOf(one.id)).find((e) => /НЕ согласен/.test(e.action_text));
    assert.equal(verdictNote.status, 'pending');
    check('discrepancy act: seller answers once after completion, dispute needs a reason and alerts the warehouse');

    // 9. Приёмка без отметки у ворот сама ставит «машина приехала».
    const two = (await api('POST', '/api/sellers/inbound', sa, { grid, apply: true })).invoice;
    const inv2 = await api('GET', `/api/invoices/${two.id}`, worker);
    await api('POST', '/api/receiving', worker, { invoiceItemId: inv2.items[0].id, acceptedQty: 10, cellBlockId: cell }, 201);
    card = await api('GET', `/api/inbound/${two.id}`, sa);
    assert.ok(card.arrivedAt); assert.equal(card.unplaced, 0);
    check('first received line marks the truck as arrived');

    console.log(`\n${passed} checks passed`);
  } finally {
    await new Promise((r) => server.close(r)); await pool.end();
  }
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
