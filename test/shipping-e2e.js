// End-to-end check of the outbound (отгрузка) flow against a real Postgres.
//
// Connects as argus_app, NOT the migration owner — RLS is silently bypassed for
// table owners, so testing as the owner role would prove nothing about tenant
// isolation. Run against a throwaway database only; it writes freely.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/shipping-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');

const PORT = 3999;
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

    // ---------- Setup: owner, company, staff key, layout ----------
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

    const companyA = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Alpha' },
    });
    assert.equal(companyA.status, 201, `company A: ${JSON.stringify(companyA.body)}`);
    const companyAId = companyA.body.id;

    const companyB = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Beta' },
    });
    const companyBId = companyB.body.id;

    const staff = await api('POST', '/api/staff', {
      token: ownerToken, body: { name: 'Worker One' },
    });
    assert.equal(staff.status, 201, `staff: ${JSON.stringify(staff.body)}`);

    const workerLogin = await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    });
    assert.equal(workerLogin.status, 200, `worker login: ${JSON.stringify(workerLogin.body)}`);
    const workerToken = workerLogin.body.token;

    // Two rows so the suggest ordering (row, rack, tier) has something to sort.
    const layout = await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 3, tierCount: 2 }, { rackCount: 3, tierCount: 2 }] },
    });
    assert.equal(layout.status, 201, `layout: ${JSON.stringify(layout.body)}`);

    const rows = await api('GET', '/api/cells/rows', { token: ownerToken });
    const allBlocks = rows.body.flatMap((r) => r.blocks.map((b) => ({ ...b, rowNum: r.row_num })));
    assert.ok(allBlocks.length >= 3, 'expected at least 3 cell blocks');
    const cell1 = allBlocks[0];
    const cell2 = allBlocks[1];

    // ---------- Stock the shelves via the real receiving flow ----------
    // Same SKU in two different cells — the exact situation that forced
    // shipping_records to allow multiple rows per invoice line.
    async function receiveInto(cellBlockId, sku, qty, companyId, num) {
      const inv = await api('POST', '/api/invoices', {
        token: ownerToken,
        body: {
          companyId, number: `IN-${num}`, direction: 'in',
          items: [{ name: 'Widget', sku, declaredQty: qty }],
        },
      });
      assert.equal(inv.status, 201, `inbound invoice: ${JSON.stringify(inv.body)}`);
      const rec = await api('POST', '/api/receiving', {
        token: workerToken,
        body: { invoiceItemId: inv.body.items[0].id, acceptedQty: qty, cellBlockId },
      });
      assert.equal(rec.status, 201, `receiving: ${JSON.stringify(rec.body)}`);
      return inv.body;
    }

    await receiveInto(cell1.id, 'SKU-1', 60, companyAId, `${stamp}-1`);
    await receiveInto(cell2.id, 'SKU-1', 40, companyAId, `${stamp}-2`);
    const inboundInvoice = await receiveInto(cell1.id, 'SKU-2', 10, companyBId, `${stamp}-3`);

    // ---------- Outbound invoice spanning both cells ----------
    const out = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: companyAId, number: `OUT-${stamp}`, direction: 'out',
        items: [{ name: 'Widget', sku: 'SKU-1', declaredQty: 100 }],
      },
    });
    assert.equal(out.status, 201, `outbound invoice: ${JSON.stringify(out.body)}`);
    const outItemId = out.body.items[0].id;

    check('invoice created with direction=out', () => {
      assert.equal(out.body.direction, 'out');
    });

    const outList = await api('GET', '/api/invoices?direction=out', { token: ownerToken });
    check('GET /invoices?direction=out returns only outbound', () => {
      assert.equal(outList.status, 200, JSON.stringify(outList.body));
      assert.ok(outList.body.length >= 1, 'expected at least one outbound invoice');
      assert.ok(outList.body.every((i) => i.direction === 'out'), 'found a non-outbound row');
    });

    const inList = await api('GET', '/api/invoices?direction=in', { token: ownerToken });
    check('GET /invoices?direction=in returns only inbound', () => {
      assert.ok(inList.body.every((i) => i.direction === 'in'), 'found a non-inbound row');
    });

    const badFilter = await api('GET', '/api/invoices?direction=sideways', { token: ownerToken });
    check('invalid direction filter rejected', () => {
      assert.equal(badFilter.status, 400, JSON.stringify(badFilter.body));
    });

    // ---------- Suggest: where does this SKU physically sit? ----------
    const suggest = await api('GET', `/api/shipping/suggest/${outItemId}`, { token: workerToken });
    check('suggest lists both cells holding the SKU', () => {
      assert.equal(suggest.status, 200, JSON.stringify(suggest.body));
      assert.equal(suggest.body.cells.length, 2, `got ${suggest.body.cells.length} cells`);
      assert.equal(suggest.body.totalAvailable, 100);
      assert.equal(suggest.body.shortfall, 0);
      assert.equal(suggest.body.item.remaining, 100);
    });

    check('suggest is ordered as a walking route', () => {
      const keys = suggest.body.cells.map((c) => [c.rowNum, c.rackStart, c.tierStart]);
      const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      assert.deepEqual(keys, sorted, 'cells are not in row/rack/tier order');
    });

    // ---------- Guard rails ----------
    const overdraw = await api('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: outItemId, pickedQty: 999, cellBlockId: cell1.id },
    });
    check('cannot pick more than the cell holds', () => {
      assert.equal(overdraw.status, 409, JSON.stringify(overdraw.body));
    });

    const wrongDirection = await api('POST', '/api/shipping', {
      token: workerToken,
      body: {
        invoiceItemId: inboundInvoice.items[0].id, pickedQty: 1, cellBlockId: cell1.id,
      },
    });
    check('cannot pick against an inbound invoice', () => {
      assert.equal(wrongDirection.status, 400, JSON.stringify(wrongDirection.body));
    });

    const zeroQty = await api('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: outItemId, pickedQty: 0, cellBlockId: cell1.id },
    });
    check('zero quantity rejected', () => {
      assert.equal(zeroQty.status, 400, JSON.stringify(zeroQty.body));
    });

    const ownerPick = await api('POST', '/api/shipping', {
      token: ownerToken,
      body: { invoiceItemId: outItemId, pickedQty: 1, cellBlockId: cell1.id },
    });
    check('owner cannot record a pick (worker-only route)', () => {
      assert.equal(ownerPick.status, 403, JSON.stringify(ownerPick.body));
    });

    // ---------- The real flow: two cells, closed on the second ----------
    const pick1 = await api('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: outItemId, pickedQty: 60, cellBlockId: cell1.id, isFinal: false },
    });
    check('partial pick from first cell accepted', () => {
      assert.equal(pick1.status, 201, JSON.stringify(pick1.body));
      assert.equal(Number(pick1.body.totalPicked), 60);
    });

    const afterFirst = await api('GET', '/api/cells/rows', { token: ownerToken });
    check('first cell emptied and freed', () => {
      const block = afterFirst.body.flatMap((r) => r.blocks).find((b) => b.id === cell1.id);
      const sku1 = block.stock.filter((s) => s.sku === 'SKU-1');
      assert.equal(sku1.length, 0, 'SKU-1 stock should be gone from cell 1');
    });

    const midInvoice = await api('GET', `/api/invoices/${out.body.id}`, { token: ownerToken });
    check('invoice still in progress after partial pick', () => {
      assert.equal(midInvoice.body.status, 'in_progress', midInvoice.body.status);
      assert.equal(Number(midInvoice.body.items[0].picked_qty), 60);
      assert.equal(midInvoice.body.items[0].closed, false);
      assert.equal(midInvoice.body.items[0].picks.length, 1);
    });

    const suggest2 = await api('GET', `/api/shipping/suggest/${outItemId}`, { token: workerToken });
    check('suggest reflects what is already picked', () => {
      assert.equal(suggest2.body.item.alreadyPicked, 60);
      assert.equal(suggest2.body.item.remaining, 40);
      assert.equal(suggest2.body.cells.length, 1, 'emptied cell should drop off the list');
    });

    const pick2 = await api('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: outItemId, pickedQty: 40, cellBlockId: cell2.id, isFinal: true },
    });
    check('final pick closes the line', () => {
      assert.equal(pick2.status, 201, JSON.stringify(pick2.body));
      assert.equal(Number(pick2.body.totalPicked), 100);
    });

    const doneInvoice = await api('GET', `/api/invoices/${out.body.id}`, { token: ownerToken });
    check('invoice completed once every line is closed', () => {
      assert.equal(doneInvoice.body.status, 'completed', doneInvoice.body.status);
      assert.equal(doneInvoice.body.items[0].closed, true);
      assert.equal(doneInvoice.body.items[0].picks.length, 2, 'expected both picks recorded');
    });

    const reopen = await api('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: outItemId, pickedQty: 1, cellBlockId: cell2.id },
    });
    check('closed line cannot be picked again', () => {
      assert.equal(reopen.status, 409, JSON.stringify(reopen.body));
    });

    // ---------- Journal: exact-match picks must not raise a discrepancy ----------
    const journal = await api('GET', '/api/journal', { token: ownerToken });
    const shippingEntries = journal.body.filter((e) => e.entity_id === outItemId);
    check('both picks are journalled', () => {
      assert.equal(shippingEntries.length, 2, `got ${shippingEntries.length} entries`);
    });
    check('exact pick raises no discrepancy', () => {
      assert.ok(
        shippingEntries.every((e) => e.status === 'auto'),
        `unexpected pending entry: ${JSON.stringify(shippingEntries.map((e) => e.status))}`,
      );
    });

    // ---------- Short pick must raise a discrepancy ----------
    const shortOut = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: companyBId, number: `OUT-SHORT-${stamp}`, direction: 'out',
        items: [{ name: 'Gadget', sku: 'SKU-2', declaredQty: 10 }],
      },
    });
    const shortItemId = shortOut.body.items[0].id;
    const shortPick = await api('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: shortItemId, pickedQty: 4, cellBlockId: cell1.id, isFinal: true },
    });
    check('short final pick accepted', () => {
      assert.equal(shortPick.status, 201, JSON.stringify(shortPick.body));
    });

    const journal2 = await api('GET', '/api/journal', { token: ownerToken });
    check('short pick flagged pending for the owner', () => {
      const entry = journal2.body.find((e) => e.entity_id === shortItemId);
      assert.ok(entry, 'no journal entry for the short pick');
      assert.equal(entry.status, 'pending', entry.status);
    });

    // ---------- Tenant isolation on the new table ----------
    const keyA = await api('POST', `/api/sellers/companies/${companyAId}/keys`, { token: ownerToken });
    const sellerA = await api('POST', '/api/auth/seller/login', {
      body: { keyCode: keyA.body.key_code, name: 'Seller A' },
    });
    const sellerAToken = sellerA.body.token;

    const sellerInvoices = await api('GET', '/api/invoices', { token: sellerAToken });
    check('seller sees only their own company invoices', () => {
      assert.equal(sellerInvoices.status, 200, JSON.stringify(sellerInvoices.body));
      assert.ok(sellerInvoices.body.length > 0, 'seller should see their own invoices');
      assert.ok(
        sellerInvoices.body.every((i) => i.company_id === companyAId),
        'seller sees another company\'s invoice',
      );
    });

    const sellerSeesOwn = await api('GET', `/api/invoices/${out.body.id}`, { token: sellerAToken });
    check('seller can open their own outbound invoice with picks', () => {
      assert.equal(sellerSeesOwn.status, 200, JSON.stringify(sellerSeesOwn.body));
      assert.equal(sellerSeesOwn.body.items[0].picks.length, 2);
    });

    const sellerSeesOther = await api('GET', `/api/invoices/${shortOut.body.id}`, { token: sellerAToken });
    check('seller blocked from another company outbound invoice', () => {
      assert.equal(sellerSeesOther.status, 404, JSON.stringify(sellerSeesOther.body));
    });

    const sellerJournal = await api('GET', '/api/journal', { token: sellerAToken });
    check('seller cannot read the journal at all', () => {
      assert.equal(sellerJournal.status, 403, JSON.stringify(sellerJournal.body));
    });
    console.log('');
    console.log('Заполненность ячейки');
    console.log('');

    // Раньше приёмка ставила fill_pct = 100 при любом количестве, и карта
    // красила оранжевым ячейку с горстью товара — то есть сообщала «склад
    // забит», когда он почти пуст. Процент считается от условной вместимости
    // в 500 штук (см. src/cells/fill.js).
    const fillOf = async (blockId) => {
      const fresh = await api('GET', '/api/cells/rows', { token: ownerToken });
      return fresh.body.flatMap((r) => r.blocks).find((b) => b.id === blockId);
    };

    const fillCell = allBlocks[allBlocks.length - 1];
    await receiveInto(fillCell.id, 'FILL-50', 50, companyAId, stamp + '-f1');
    const afterSmall = await fillOf(fillCell.id);
    check('50 штук из 500 — это 10 процентов, а не сто', () => {
      assert.equal(afterSmall.state, 'occupied');
      assert.equal(afterSmall.fill_pct, 10);
    });

    await receiveInto(fillCell.id, 'FILL-REST', 450, companyAId, stamp + '-f2');
    const afterFull = await fillOf(fillCell.id);
    check('пятьсот штук заполняют ячейку целиком', () => {
      assert.equal(afterFull.fill_pct, 100);
    });

    const tinyCell = allBlocks[allBlocks.length - 2];
    await receiveInto(tinyCell.id, 'FILL-ONE', 1, companyAId, stamp + '-f3');
    const afterTiny = await fillOf(tinyCell.id);
    check('одна штука не показывается как пустая ячейка', () => {
      assert.equal(afterTiny.fill_pct, 1);
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
