// Execute only with an explicitly named disposable database.
// Продавец оформляет привоз файлом: разбор любой таблицы, сопоставление с его
// каталогом, приход «ждёт приёмки» у склада, акт приёмки — только своему.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const { parseInboundSheet } = require('../src/sellers/inbound');

(async () => {
  // Разбор без базы: шаблон WB, своя таблица, «кол-во коробов» — не количество.
  assert.deepEqual(parseInboundSheet([['Баркод', 'Количество'], ['4600000000011', 10], ['', ''], ['4600000000028', '0'], ['Итого', 10]])
    .map((l) => [l.barcode, l.qty]), [['4600000000011', 10]]);
  const own = parseInboundSheet([['Поставка от 25.09'], [], ['Артикул', 'Наименование', 'Кол-во коробов', 'Кол-во, шт.'], ['ART-3', 'Носки', 2, '1 200'], ['Итого', '', 2, 1200]]);
  assert.deepEqual(own.map((l) => [l.article, l.qty]), [['ART-3', 1200]]);
  assert.throws(() => parseInboundSheet([['a', 'b'], [1, 2]]), /колонку количества/);
  console.log('PASS inbound sheet parsing: WB template, own table, boxes column ignored, totals skipped');

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, path, token, body, status = 200) {
    const response = await fetch(base + path, { method, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${response.status} ${data.error || ''}`);
    return data;
  }
  try {
    const owner = await api('POST', '/api/auth/owner/register', null, {
      name: 'Test owner', email: `seller-inbound-${Date.now()}@example.test`, password: 'test-only-password',
      warehouseName: 'Isolated seller inbound', city: 'Test',
    }, 201);
    const token = owner.token;
    const a = await api('POST', '/api/sellers/companies', token, { name: 'Inbound A' }, 201);
    const b = await api('POST', '/api/sellers/companies', token, { name: 'Inbound B' }, 201);
    async function seller(company) {
      const key = await api('POST', `/api/sellers/companies/${company.id}/keys`, token, {}, 201);
      return (await api('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Test seller' })).token;
    }
    const sa = await seller(a); const sb = await seller(b);
    const workerKey = await api('POST', '/api/staff', token, { name: 'Test worker' }, 201);
    const worker = (await api('POST', '/api/auth/staff/login', null, { keyCode: workerKey.key_code })).token;
    const warehouseId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).warehouseId;
    await withTenantContext({ warehouseId }, async (c) => {
      await c.query(
        `INSERT INTO products (warehouse_id, company_id, sku, name, barcode) VALUES
           ($1, $2, 'IN-1', 'Футболка', '4600000000011'),
           ($1, $2, 'IN-2', 'Шорты синие 4600000000028', NULL),
           ($1, $2, 'IN-3', 'Носки', NULL)`, [warehouseId, a.id]);
      await c.query(
        `INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article)
         VALUES ($1, $2, 'IN-3', 'wb', '555000111', 'ART-3')`, [warehouseId, a.id]);
    });

    const grid = [['Баркод', 'Количество'], ['4600000000011', 10], ['4600000000028', '5'], ['4600000000011', 2], ['9999999999999', 3]];
    const preview = await api('POST', '/api/sellers/inbound', sa, { grid });
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.summary, { lines: 4, matched: 3, notMatched: 1, products: 2, units: 17 });
    assert.equal(preview.lines.find((l) => l.barcode === '9999999999999').sku, null);
    const byArticle = await api('POST', '/api/sellers/inbound', sa, { grid: [['Артикул', 'Кол-во'], ['art-3', 4]] });
    assert.equal(byArticle.lines[0].sku, 'IN-3');
    // Чужой каталог не узнаётся: у B этих штрихкодов нет.
    const foreign = await api('POST', '/api/sellers/inbound', sb, { grid });
    assert.equal(foreign.summary.matched, 0);
    await api('POST', '/api/sellers/inbound', sb, { grid, apply: true }, 400);
    await api('POST', '/api/sellers/inbound', sa, { grid, apply: true, plannedDate: '26.09.2026' }, 400);
    console.log('PASS preview: barcode in field or name tail, article via WB mapping, other seller catalog not matched');

    const done = await api('POST', '/api/sellers/inbound', sa, { grid, apply: true, plannedDate: '2026-09-27', comment: 'Газель, 3 короба' });
    assert.equal(done.applied, true);
    assert.match(done.invoice.number, /^ПР-\d{6}-\d+$/);
    const again = await api('POST', '/api/sellers/inbound', sa, { grid: [['Артикул', 'Кол-во'], ['ART-3', 4]], apply: true });
    assert.notEqual(again.invoice.number, done.invoice.number);

    const incoming = await api('GET', '/api/invoices?direction=in', worker);
    const list = Array.isArray(incoming) ? incoming : incoming.rows;
    const inv = list.find((r) => r.id === done.invoice.id);
    assert.ok(inv, 'worker sees the inbound'); assert.equal(inv.status, 'open');
    const detail = await api('GET', `/api/invoices/${done.invoice.id}`, worker);
    assert.deepEqual(detail.items.map((i) => [i.sku, Number(i.declared_qty)]).sort(), [['IN-1', 12], ['IN-2', 5]]);
    const docs = await api('GET', '/api/sellers/documents', sa);
    assert.ok(docs.rows.some((r) => r.id === done.invoice.id));
    const journalRow = await withTenantContext({ warehouseId }, (c) => c.query(
      'SELECT action_text FROM journal_entries WHERE invoice_id = $1', [done.invoice.id]));
    assert.match(journalRow.rows[0].action_text, /Inbound A.*2 товаров, 17 шт\..*27\.09\.2026.*Газель/);
    console.log('PASS apply: open receipt with aggregated items, unique numbers, worker and seller see it, journal entry');

    const act = await api('GET', `/api/acts/receipt/${done.invoice.id}`, sa);
    assert.equal(act.seller, 'Inbound A');
    await api('GET', `/api/acts/receipt/${done.invoice.id}`, sb, undefined, 404);
    await api('GET', `/api/acts/receipt/${done.invoice.id}`, worker, undefined, 403);
    console.log('PASS receipt act: own seller yes, other seller 404, worker 403');
  } finally {
    await new Promise((r) => server.close(r)); await pool.end();
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
