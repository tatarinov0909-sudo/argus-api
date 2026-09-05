// End-to-end check of the returns (возврат) flow against a real Postgres.
//
// Connects as argus_app, NOT the migration owner — RLS is silently bypassed for
// table owners, so testing as the owner role would prove nothing about tenant
// isolation. Run against a throwaway database only; it writes freely.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/returns-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();

    // ---------- Setup: owner, company, staff key, one cell ----------
    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Test Owner',
        email: `owner${stamp}@test.local`,
        password: 'secret123',
        warehouseName: 'Test Warehouse',
        city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
    const ownerToken = reg.body.token;

    const company = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Alpha' },
    });
    const companyId = company.body.id;

    const staff = await api('POST', '/api/staff', {
      token: ownerToken, body: { name: 'Worker One' },
    });
    const workerLogin = await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    });
    const workerToken = workerLogin.body.token;

    const layout = await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 2, tierCount: 2 }] },
    });
    assert.equal(layout.status, 201, `layout: ${JSON.stringify(layout.body)}`);
    const rows = await api('GET', '/api/cells/rows', { token: ownerToken });
    const cell = rows.body.flatMap((r) => r.blocks)[0];

    // ---------- A return invoice with one line of 10 ----------
    const ret = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId, number: `RET-${stamp}`, direction: 'return',
        items: [{ name: 'Lemonade', sku: 'SKU-RET', declaredQty: 10 }],
      },
    });
    assert.equal(ret.status, 201, `return invoice: ${JSON.stringify(ret.body)}`);
    const itemId = ret.body.items[0].id;

    check('invoice created with direction=return', () => {
      assert.equal(ret.body.direction, 'return');
    });

    const retList = await api('GET', '/api/invoices?direction=return', { token: ownerToken });
    check('GET /invoices?direction=return returns only returns', () => {
      assert.equal(retList.status, 200, JSON.stringify(retList.body));
      assert.ok(retList.body.some((i) => i.id === ret.body.id));
      assert.ok(retList.body.every((i) => i.direction === 'return'));
    });

    // ---------- Guard rails ----------
    const badBucket = await api('POST', '/api/returns', {
      token: workerToken,
      body: { invoiceItemId: itemId, qty: 1, qualityBucket: 'sideways' },
    });
    check('unknown quality bucket rejected', () => {
      assert.equal(badBucket.status, 400, JSON.stringify(badBucket.body));
    });

    const zeroQty = await api('POST', '/api/returns', {
      token: workerToken,
      body: { invoiceItemId: itemId, qty: 0, qualityBucket: 'good' },
    });
    check('zero quantity rejected', () => {
      assert.equal(zeroQty.status, 400, JSON.stringify(zeroQty.body));
    });

    const ownerSort = await api('POST', '/api/returns', {
      token: ownerToken,
      body: { invoiceItemId: itemId, qty: 1, qualityBucket: 'good' },
    });
    check('owner cannot sort a return (worker-only route)', () => {
      assert.equal(ownerSort.status, 403, JSON.stringify(ownerSort.body));
    });

    // ---------- The real flow: split 10 into three buckets ----------
    const goodPick = await api('POST', '/api/returns', {
      token: workerToken,
      body: { invoiceItemId: itemId, qty: 7, qualityBucket: 'good', cellBlockId: cell.id },
    });
    check('good bucket accepted and shelved', () => {
      assert.equal(goodPick.status, 201, JSON.stringify(goodPick.body));
      assert.equal(goodPick.body.quality_bucket, 'good');
    });

    const afterGood = await api('GET', '/api/cells/rows', { token: ownerToken });
    check('good bucket actually landed in the cell', () => {
      const block = afterGood.body.flatMap((r) => r.blocks).find((b) => b.id === cell.id);
      const stock = block.stock.filter((s) => s.sku === 'SKU-RET');
      assert.equal(stock.length, 1);
      assert.equal(Number(stock[0].qty), 7);
    });

    const midInvoice = await api('GET', `/api/invoices/${ret.body.id}`, { token: ownerToken });
    check('invoice still in progress after partial sort', () => {
      assert.equal(midInvoice.body.status, 'in_progress', midInvoice.body.status);
      assert.equal(Number(midInvoice.body.items[0].returned_qty), 7);
      assert.equal(midInvoice.body.items[0].buckets.length, 1);
    });

    const defectivePick = await api('POST', '/api/returns', {
      token: workerToken,
      body: {
        invoiceItemId: itemId, qty: 2, qualityBucket: 'defective',
        defectNote: 'Раздавлена коробка, потёк сироп',
      },
    });
    check('defective bucket accepted without a cell', () => {
      assert.equal(defectivePick.status, 201, JSON.stringify(defectivePick.body));
      assert.equal(defectivePick.body.cell_block_id, null);
    });

    // ---------- Описание дефекта ----------
    // «2 шт брак» без причины продавцу решать не помогает: вернуть товар себе
    // на производство или утилизировать — разные решения.
    check('причина брака сохраняется вместе с количеством', () => {
      assert.equal(defectivePick.status, 201, JSON.stringify(defectivePick.body));
    });

    const withNote = await api('GET', `/api/invoices/${ret.body.id}`, { token: ownerToken });
    check('причина видна в накладной', () => {
      const bucket = withNote.body.items[0].buckets.find((b) => b.qualityBucket === 'defective');
      assert.ok(bucket, JSON.stringify(withNote.body.items[0].buckets));
      assert.equal(bucket.defectNote, 'Раздавлена коробка, потёк сироп');
    });

    const journalWithNote = await api('GET', '/api/journal', { token: ownerToken });
    check('причина уходит в журнал владельцу', () => {
      const entry = journalWithNote.body.find((e) => e.action_text.includes('Раздавлена коробка'));
      assert.ok(entry, 'в журнале нет записи с причиной');
    });

    const overshoot = await api('POST', '/api/returns', {
      token: workerToken,
      body: { invoiceItemId: itemId, qty: 5, qualityBucket: 'packaging_defect' },
    });
    check('cannot sort more than declared across all buckets', () => {
      assert.equal(overshoot.status, 409, JSON.stringify(overshoot.body));
    });

    const packagingPick = await api('POST', '/api/returns', {
      token: workerToken,
      body: { invoiceItemId: itemId, qty: 1, qualityBucket: 'packaging_defect' },
    });
    check('final bucket closes the line', () => {
      assert.equal(packagingPick.status, 201, JSON.stringify(packagingPick.body));
    });

    const doneInvoice = await api('GET', `/api/invoices/${ret.body.id}`, { token: ownerToken });
    check('invoice completed once every unit is sorted', () => {
      assert.equal(doneInvoice.body.status, 'completed', doneInvoice.body.status);
      assert.equal(doneInvoice.body.items[0].buckets.length, 3);
      const total = doneInvoice.body.items[0].buckets
        .reduce((sum, b) => sum + Number(b.qty), 0);
      assert.equal(total, 10);
    });

    // ---------- Journal: three sorts, all auto (no discrepancy concept here) ----------
    const journal = await api('GET', '/api/journal', { token: ownerToken });
    const returnEntries = journal.body.filter((e) => e.entity_id === itemId);
    check('every bucket sort is journalled', () => {
      assert.equal(returnEntries.length, 3, `got ${returnEntries.length} entries`);
    });
    // Запись должна вести к документу и к месту, иначе журнал остаётся текстом:
    // прочитать про ячейку можно, а пойти в неё — нет.
    // Обратный ход: из ячейки и из накладной — вся их история.
    const cellId = returnEntries.find((e) => e.cell_block_id)?.cell_block_id;
    const byCell = cellId
      ? await api('GET', `/api/journal?cellBlockId=${cellId}`, { token: ownerToken })
      : null;
    const byInvoice = await api('GET',
      `/api/journal?invoiceId=${returnEntries[0].invoice_id}`, { token: ownerToken });
    const badId = await api('GET', '/api/journal?cellBlockId=не-uuid', { token: ownerToken });

    check('история одной ячейки отдаётся отдельно', () => {
      assert.ok(byCell, 'ни одна запись не знает ячейки');
      assert.equal(byCell.status, 200, JSON.stringify(byCell.body));
      assert.ok(byCell.body.length >= 1);
      assert.ok(byCell.body.every((e) => e.cell_block_id === cellId),
        'в историю ячейки попали чужие записи');
    });
    check('история одной накладной тоже', () => {
      assert.equal(byInvoice.status, 200, JSON.stringify(byInvoice.body));
      assert.ok(byInvoice.body.length >= 3, 'записей по накладной меньше, чем было событий');
    });
    check('мусор вместо идентификатора отклоняется, а не ищется', () => {
      assert.equal(badId.status, 400, JSON.stringify(badId.body));
    });

    check('из записи журнала видно накладную и ячейку', () => {
      const withCell = returnEntries.filter((e) => e.cell_block_id);
      assert.ok(withCell.length >= 1, 'ни одна запись не знает своей ячейки');
      assert.ok(withCell[0].cell_label, 'адрес ячейки не собран: ' + JSON.stringify(withCell[0]));
      assert.ok(returnEntries.every((e) => e.invoice_id), 'запись не знает своей накладной');
      assert.ok(returnEntries[0].invoice_number, 'номер накладной не подставлен');
    });

    // ---------- Брак не уезжает клиенту ----------
    // Брак и ждущий перепаковки товар лежат в обычных ячейках, и до появления
    // состояния на остатке отгрузка честно предлагала работнику взять их для
    // клиентского заказа: 5 штук брака в ячейке — «нехватка 0».
    const outAfterReturn = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId, number: `OUT-AFTER-RET-${stamp}`, direction: 'out',
        items: [{ name: 'Lemonade', sku: 'SKU-RET', declaredQty: 10 }],
      },
    });
    const sugg = await api('GET', `/api/shipping/suggest/${outAfterReturn.body.items[0].id}`, {
      token: workerToken,
    });
    check('к отбору предлагается только годное, брак не виден', () => {
      assert.equal(sugg.status, 200, JSON.stringify(sugg.body));
      assert.equal(sugg.body.totalAvailable, 7, 'на полке 7 годных: 7 из возврата');
      assert.equal(sugg.body.shortfall, 3, 'о нехватке говорит честно, а не прикрывает её браком');
    });

    const takeDefective = await api('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: outAfterReturn.body.items[0].id, pickedQty: 8, cellBlockId: cell.id },
    });
    check('взять больше, чем годного в ячейке, нельзя даже вручную', () => {
      assert.equal(takeDefective.status, 409, JSON.stringify(takeDefective.body));
    });

    // ---------- Tenant isolation on the new table ----------
    const key = await api('POST', `/api/sellers/companies/${companyId}/keys`, { token: ownerToken });
    const seller = await api('POST', '/api/auth/seller/login', {
      body: { keyCode: key.body.key_code, name: 'Seller' },
    });
    const sellerToken = seller.body.token;

    const sellerSeesOwn = await api('GET', `/api/invoices/${ret.body.id}`, { token: sellerToken });
    check('seller can see their own return with the quality split', () => {
      assert.equal(sellerSeesOwn.status, 200, JSON.stringify(sellerSeesOwn.body));
      assert.equal(sellerSeesOwn.body.items[0].buckets.length, 3);
    });
  } catch (err) {
    failures.push({ name: 'SETUP', message: err.message });
    console.log(`\n  SETUP ERROR: ${err.message}`);
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  }
  process.exit(failures.length ? 1 : 0);
})();
