// End-to-end check of the 1C sync layer against a real Postgres, connected as
// argus_app so RLS applies. Focuses on the ways a scheduled poller actually
// breaks things: re-sending the same batch, re-sending a document a worker has
// already started, losing an acknowledgement, and having its key revoked.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/sync-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

const PORT = 3997;
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

    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Sync Owner',
        email: `sync${stamp}@test.local`,
        password: 'secret123',
        warehouseName: 'Sync Warehouse',
      },
    });
    assert.equal(reg.status, 201, `register: ${JSON.stringify(reg.body)}`);
    const ownerToken = reg.body.token;

    // ---------- Integration key ----------
    const keyRes = await api('POST', '/api/sync/keys', {
      token: ownerToken, body: { label: '1C Main' },
    });
    check('owner can issue an integration key', () => {
      assert.equal(keyRes.status, 201, JSON.stringify(keyRes.body));
      assert.ok(keyRes.body.key_code.startsWith('1C-'), keyRes.body.key_code);
      assert.equal(keyRes.body.active, true);
    });
    const keyCode = keyRes.body.key_code;

    const auth = await api('POST', '/api/sync/auth', { body: { keyCode } });
    check('1C module authenticates with the key', () => {
      assert.equal(auth.status, 200, JSON.stringify(auth.body));
      assert.ok(auth.body.token, 'no token issued');
    });
    let syncToken = auth.body.token;

    const badAuth = await api('POST', '/api/sync/auth', { body: { keyCode: '1C-0000-DEADBEEF' } });
    check('unknown key rejected', () => {
      assert.equal(badAuth.status, 404, JSON.stringify(badAuth.body));
    });

    const ownerOnSync = await api('GET', '/api/sync/changes', { token: ownerToken });
    check('owner token cannot pull the sync feed', () => {
      assert.equal(ownerOnSync.status, 403, JSON.stringify(ownerOnSync.body));
    });

    const syncOnJournal = await api('GET', '/api/journal', { token: syncToken });
    check('integration token cannot read the journal', () => {
      assert.equal(syncOnJournal.status, 403, JSON.stringify(syncOnJournal.body));
    });

    // ---------- Adoption: a company created by hand before 1C existed ----------
    const manual = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Romashka' },
    });
    const manualCompanyId = manual.body.id;

    const pushCo = await api('POST', '/api/sync/push/companies', {
      token: syncToken,
      body: {
        records: [
          { externalId: 'c-guid-1', name: 'Romashka' },
          { externalId: 'c-guid-2', name: 'Vasilek' },
        ],
      },
    });
    check('existing company adopted instead of duplicated', () => {
      assert.equal(pushCo.status, 200, JSON.stringify(pushCo.body));
      const adopted = pushCo.body.results.find((r) => r.externalId === 'c-guid-1');
      assert.equal(adopted.status, 'adopted', JSON.stringify(adopted));
      assert.equal(adopted.id, manualCompanyId, 'adopted a different row than the manual one');
    });
    check('unknown company created', () => {
      const created = pushCo.body.results.find((r) => r.externalId === 'c-guid-2');
      assert.equal(created.status, 'created', JSON.stringify(created));
    });

    const companies = await api('GET', '/api/sellers/companies', { token: ownerToken });
    check('adoption did not create a duplicate', () => {
      const romashkas = companies.body.filter((c) => c.name === 'Romashka');
      assert.equal(romashkas.length, 1, `found ${romashkas.length} Romashka rows`);
    });

    const pushCoAgain = await api('POST', '/api/sync/push/companies', {
      token: syncToken,
      body: { records: [{ externalId: 'c-guid-1', name: 'Romashka' }] },
    });
    check('re-pushing the same company is idempotent', () => {
      assert.equal(pushCoAgain.body.results[0].status, 'updated');
      assert.equal(pushCoAgain.body.results[0].id, manualCompanyId);
    });

    // ---------- Scalable seller mapping: 1C directory -> existing Argus company ----------
    const mappedSeller = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Mapped Seller' },
    });
    const staged = await api('POST', '/api/sync/push/counterparties', {
      token: syncToken,
      body: { records: [{ externalId: 'cp-guid-mapped', name: 'Контрагент из 1С' }] },
    });
    check('1C counterparty is staged without creating a seller', () => {
      assert.equal(staged.status, 200, JSON.stringify(staged.body));
      assert.equal(staged.body.results[0].status, 'updated');
    });

    const searchCounterparty = await api('GET', '/api/sellers/1c-counterparties?q=Контрагент', {
      token: ownerToken,
    });
    check('owner can search the staged 1C directory', () => {
      assert.equal(searchCounterparty.status, 200, JSON.stringify(searchCounterparty.body));
      assert.equal(searchCounterparty.body.rows[0].external_id, 'cp-guid-mapped');
      assert.equal(searchCounterparty.body.rows[0].mapped_company_id, null);
    });

    const mapped = await api('PUT', `/api/sellers/companies/${mappedSeller.body.id}/1c-counterparty`, {
      token: ownerToken, body: { externalId: 'cp-guid-mapped' },
    });
    check('owner links one Argus company to one 1C counterparty', () => {
      assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
      assert.equal(mapped.body.external_id, 'cp-guid-mapped');
    });

    const duplicateMapping = await api('PUT', `/api/sellers/companies/${manualCompanyId}/1c-counterparty`, {
      token: ownerToken, body: { externalId: 'cp-guid-mapped' },
    });
    check('one 1C counterparty cannot be linked to two sellers', () => {
      assert.equal(duplicateMapping.status, 409, JSON.stringify(duplicateMapping.body));
    });

    const unassignedProduct = await api('POST', '/api/sync/push/products', {
      token: syncToken,
      body: { records: [{ externalId: 'p-guid-unassigned', sku: 'SKU-U', name: 'Unassigned first' }] },
    });
    check('1C product can arrive safely before seller mapping is applied to a document', () => {
      assert.equal(unassignedProduct.body.results[0].status, 'created', JSON.stringify(unassignedProduct.body));
    });

    const zeroStock = await api('POST', '/api/sync/push/stock', {
      token: syncToken,
      body: { records: [{ productExternalId: 'p-guid-unassigned', sku: 'SKU-U', qty: 0 }] },
    });
    check('zero stock is accepted by stable 1C product id', () => {
      assert.equal(zeroStock.body.results[0].status, 'updated', JSON.stringify(zeroStock.body));
    });

    const mappedInvoice = await api('POST', '/api/sync/push/invoices', {
      token: syncToken,
      body: { records: [{
        externalId: 'i-guid-mapped', number: 'IN-MAPPED', direction: 'in',
        companyExternalId: 'cp-guid-mapped',
        items: [{ productExternalId: 'p-guid-unassigned', sku: 'SKU-U', name: 'Unassigned first', declaredQty: 1 }],
      }] },
    });
    check('mapped 1C document assigns its product to the seller', () => {
      assert.equal(mappedInvoice.body.results[0].status, 'created', JSON.stringify(mappedInvoice.body));
    });

    const mappedKey = await api('POST', `/api/sellers/companies/${mappedSeller.body.id}/keys`, {
      token: ownerToken,
    });
    const mappedLogin = await api('POST', '/api/auth/seller/login', {
      body: { keyCode: mappedKey.body.key_code, name: 'Mapped user' },
    });
    const mappedStock = await api('GET', '/api/sellers/stock', { token: mappedLogin.body.token });
    check('seller sees the assigned product and the explicit zero from 1C', () => {
      const row = mappedStock.body.find((item) => item.sku === 'SKU-U');
      assert.ok(row, JSON.stringify(mappedStock.body));
      assert.equal(row.qtyIn1c, 0);
      // A number from 1C is the reconciliation source. Physical Argus stock
      // remains unknown until the warehouse receives or counts the product.
      assert.equal(row.stockKnown, false);
    });

    // ---------- Products ----------
    const pushProd = await api('POST', '/api/sync/push/products', {
      token: syncToken,
      body: {
        records: [
          {
            externalId: 'p-guid-1', companyExternalId: 'c-guid-1', sku: 'SKU-1',
            name: 'Widget', category: 'Tools',
            lengthMm: 100, widthMm: 50, heightMm: 25, weightG: 300,
          },
          {
            externalId: 'p-guid-2', companyExternalId: 'c-guid-UNKNOWN', sku: 'SKU-X',
            name: 'Orphan',
          },
          { externalId: 'p-guid-3', sku: '', name: 'Broken' },
        ],
      },
    });
    check('product created with its 1C card data', () => {
      const ok = pushProd.body.results.find((r) => r.externalId === 'p-guid-1');
      assert.equal(ok.status, 'created', JSON.stringify(ok));
    });
    check('row referencing an unsynced company reported, not fatal', () => {
      const orphan = pushProd.body.results.find((r) => r.externalId === 'p-guid-2');
      assert.equal(orphan.status, 'error', JSON.stringify(orphan));
    });
    check('malformed row does not abort the batch', () => {
      const broken = pushProd.body.results.find((r) => r.externalId === 'p-guid-3');
      assert.equal(broken.status, 'error', JSON.stringify(broken));
      assert.equal(pushProd.body.summary.created, 1, JSON.stringify(pushProd.body.summary));
    });

    const prodList = await api('GET', '/api/products', { token: ownerToken });
    check('synced product is visible with category and dimensions', () => {
      const p = prodList.body.find((x) => x.sku === 'SKU-1');
      assert.ok(p, 'product not found');
      assert.equal(p.category, 'Tools');
      assert.equal(Number(p.length_mm), 100);
      assert.equal(p.external_id, 'p-guid-1');
    });

    // ---------- Invoices ----------
    const pushInv = await api('POST', '/api/sync/push/invoices', {
      token: syncToken,
      body: {
        records: [{
          externalId: 'i-guid-1', number: 'IN-001', direction: 'in',
          companyExternalId: 'c-guid-1',
          items: [{ externalId: 'l-guid-1', sku: 'SKU-1', name: 'Widget', declaredQty: 40 }],
        }],
      },
    });
    check('invoice pulled in from 1C', () => {
      assert.equal(pushInv.status, 200, JSON.stringify(pushInv.body));
      assert.equal(pushInv.body.results[0].status, 'created');
    });
    const invoiceId = pushInv.body.results[0].id;

    const invDetail = await api('GET', `/api/invoices/${invoiceId}`, { token: ownerToken });
    check('synced invoice carries its line and 1C id', () => {
      assert.equal(invDetail.body.number, 'IN-001');
      assert.equal(invDetail.body.items.length, 1);
      assert.equal(Number(invDetail.body.items[0].declared_qty), 40);
    });

    const pushInvAgain = await api('POST', '/api/sync/push/invoices', {
      token: syncToken,
      body: {
        records: [{
          externalId: 'i-guid-1', number: 'IN-001', direction: 'in',
          companyExternalId: 'c-guid-1',
          items: [{ externalId: 'l-guid-1', sku: 'SKU-1', name: 'Widget', declaredQty: 45 }],
        }],
      },
    });
    check('re-pushing an untouched invoice updates it', () => {
      assert.equal(pushInvAgain.body.results[0].status, 'updated');
    });

    // ---------- The guard that matters: do not wipe work in progress ----------
    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'W' } });
    const workerLogin = await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    });
    const workerToken = workerLogin.body.token;

    await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 2, tierCount: 1 }] },
    });
    const rows = await api('GET', '/api/cells/rows', { token: ownerToken });
    const cell = rows.body[0].blocks[0];

    const freshDetail = await api('GET', `/api/invoices/${invoiceId}`, { token: ownerToken });
    const lineId = freshDetail.body.items[0].id;
    const received = await api('POST', '/api/receiving', {
      token: workerToken,
      body: { invoiceItemId: lineId, acceptedQty: 38, cellBlockId: cell.id },
    });
    check('worker receives the synced line', () => {
      assert.equal(received.status, 201, JSON.stringify(received.body));
    });

    const pushOverInProgress = await api('POST', '/api/sync/push/invoices', {
      token: syncToken,
      body: {
        records: [{
          externalId: 'i-guid-1', number: 'IN-001', direction: 'in',
          companyExternalId: 'c-guid-1',
          items: [{ externalId: 'l-guid-1', sku: 'SKU-1', name: 'Widget', declaredQty: 999 }],
        }],
      },
    });
    check('1C cannot overwrite an invoice already being worked on', () => {
      assert.equal(pushOverInProgress.body.results[0].status, 'skipped_in_progress',
        JSON.stringify(pushOverInProgress.body.results[0]));
    });

    const afterPush = await api('GET', `/api/invoices/${invoiceId}`, { token: ownerToken });
    check('the worker\'s count survived the re-push', () => {
      assert.equal(Number(afterPush.body.items[0].accepted_qty), 38,
        JSON.stringify(afterPush.body.items[0]));
      assert.notEqual(Number(afterPush.body.items[0].declared_qty), 999,
        'declared qty was overwritten mid-receiving');
    });

    // ---------- Outbox: movements queued for 1C ----------
    const changes = await api('GET', '/api/sync/changes?since=0', { token: syncToken });
    check('receiving produced an event for 1C', () => {
      assert.equal(changes.status, 200, JSON.stringify(changes.body));
      assert.ok(changes.body.events.length >= 1, 'no events queued');
      const ev = changes.body.events.find((e) => e.event_type === 'receiving_completed');
      assert.ok(ev, 'no receiving event');
      assert.equal(Number(ev.payload.line.actualQty), 38);
      assert.equal(ev.payload.line.sku, 'SKU-1');
      assert.equal(ev.payload.invoice.externalId, 'i-guid-1');
      assert.equal(ev.payload.company.externalId, 'c-guid-1');
    });

    check('events carry no cell data — 1C has no concept of cells', () => {
      const ev = changes.body.events[0];
      const asText = JSON.stringify(ev.payload);
      assert.ok(!asText.includes('cell'), `payload mentions cells: ${asText}`);
    });

    check('cursor points at the last event', () => {
      const last = changes.body.events[changes.body.events.length - 1];
      assert.equal(changes.body.cursor, Number(last.id));
    });

    // A poller that crashes before acknowledging must see the same events again.
    const replay = await api('GET', '/api/sync/changes?since=0', { token: syncToken });
    check('unacknowledged events are re-delivered', () => {
      assert.equal(replay.body.events.length, changes.body.events.length);
    });

    const ack = await api('POST', '/api/sync/changes/ack', {
      token: syncToken, body: { upToId: changes.body.cursor },
    });
    check('acknowledgement accepted', () => {
      assert.equal(ack.status, 200, JSON.stringify(ack.body));
      assert.ok(ack.body.acknowledged >= 1);
    });

    const ackAgain = await api('POST', '/api/sync/changes/ack', {
      token: syncToken, body: { upToId: changes.body.cursor },
    });
    check('repeated acknowledgement is a harmless no-op', () => {
      assert.equal(ackAgain.body.acknowledged, 0, JSON.stringify(ackAgain.body));
    });

    const afterAck = await api('GET', `/api/sync/changes?since=${changes.body.cursor}`, {
      token: syncToken,
    });
    check('cursor advances past acknowledged events', () => {
      assert.equal(afterAck.body.events.length, 0, JSON.stringify(afterAck.body.events));
      assert.equal(afterAck.body.cursor, null);
    });

    const badAck = await api('POST', '/api/sync/changes/ack', {
      token: syncToken, body: {},
    });
    check('acknowledgement without an id rejected', () => {
      assert.equal(badAck.status, 400, JSON.stringify(badAck.body));
    });

    // ---------- Shipping emits exactly one event, on close ----------
    const outInv = await api('POST', '/api/sync/push/invoices', {
      token: syncToken,
      body: {
        records: [{
          externalId: 'i-guid-2', number: 'OUT-001', direction: 'out',
          companyExternalId: 'c-guid-1',
          items: [{ externalId: 'l-guid-2', sku: 'SKU-1', name: 'Widget', declaredQty: 20 }],
        }],
      },
    });
    const outDetail = await api('GET', `/api/invoices/${outInv.body.results[0].id}`, {
      token: ownerToken,
    });
    const outLineId = outDetail.body.items[0].id;
    const cursorBefore = afterAck.body.cursor ?? changes.body.cursor;

    await api('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: outLineId, pickedQty: 10, cellBlockId: cell.id, isFinal: false },
    });
    const midShip = await api('GET', `/api/sync/changes?since=${cursorBefore}`, { token: syncToken });
    check('partial pick queues nothing — the shipment is not done', () => {
      const shipEvents = midShip.body.events.filter((e) => e.event_type === 'shipping_completed');
      assert.equal(shipEvents.length, 0, JSON.stringify(shipEvents));
    });

    await api('POST', '/api/shipping', {
      token: workerToken,
      body: { invoiceItemId: outLineId, pickedQty: 10, cellBlockId: cell.id, isFinal: true },
    });
    const doneShip = await api('GET', `/api/sync/changes?since=${cursorBefore}`, { token: syncToken });
    check('closing the line queues exactly one shipping event with the total', () => {
      const shipEvents = doneShip.body.events.filter((e) => e.event_type === 'shipping_completed');
      assert.equal(shipEvents.length, 1, `got ${shipEvents.length}`);
      assert.equal(Number(shipEvents[0].payload.line.actualQty), 20, 'should carry the summed total');
      assert.equal(shipEvents[0].payload.direction, 'out');
    });

    // ---------- Owner-facing status ----------
    const status = await api('GET', '/api/sync/status', { token: ownerToken });
    check('owner sees sync health', () => {
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.ok(status.body.pendingEvents >= 1, JSON.stringify(status.body));
      assert.ok(status.body.lastSeenAt, 'last seen never recorded');
      assert.equal(status.body.synced_products, 2);
      assert.equal(status.body.synced_companies, 3);
      assert.equal(status.body.unassigned_products, 0);
      assert.equal(status.body.unmapped_counterparties, 0);
    });

    // ---------- Revocation ----------
    const revoked = await api('PATCH', `/api/sync/keys/${keyRes.body.id}/toggle`, {
      token: ownerToken,
    });
    check('owner can revoke the integration key', () => {
      assert.equal(revoked.body.active, false);
      assert.ok(revoked.body.revoked_at, 'revoked_at not stamped');
    });

    const authRevoked = await api('POST', '/api/sync/auth', { body: { keyCode } });
    check('revoked key cannot get a new token', () => {
      assert.equal(authRevoked.status, 403, JSON.stringify(authRevoked.body));
    });

    // ---------- Batch limits ----------
    const empty = await api('POST', '/api/sync/push/companies', {
      token: syncToken, body: { records: [] },
    });
    check('empty batch rejected', () => {
      assert.equal(empty.status, 400, JSON.stringify(empty.body));
    });

    const huge = await api('POST', '/api/sync/push/companies', {
      token: syncToken,
      body: { records: Array.from({ length: 501 }, (_, i) => ({ externalId: `x${i}`, name: `N${i}` })) },
    });
    check('oversized batch rejected', () => {
      assert.equal(huge.status, 413, JSON.stringify(huge.body));
    });

    // ---------- Cross-tenant isolation on the outbox ----------
    const other = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Other Owner', email: `other${stamp}@test.local`,
        password: 'secret123', warehouseName: 'Other Warehouse',
      },
    });
    const otherKey = await api('POST', '/api/sync/keys', { token: other.body.token, body: {} });
    const otherAuth = await api('POST', '/api/sync/auth', {
      body: { keyCode: otherKey.body.key_code },
    });
    const otherChanges = await api('GET', '/api/sync/changes?since=0', {
      token: otherAuth.body.token,
    });
    check('another warehouse 1C sees none of our events', () => {
      assert.equal(otherChanges.status, 200, JSON.stringify(otherChanges.body));
      assert.equal(otherChanges.body.events.length, 0,
        `leaked ${otherChanges.body.events.length} events across warehouses`);
    });

    const otherStatus = await api('GET', '/api/sync/status', { token: other.body.token });
    check('another warehouse sees none of our synced records', () => {
      assert.equal(otherStatus.body.synced_products, 0);
      assert.equal(otherStatus.body.synced_companies, 0);
    });
  } catch (err) {
    failures.push({ name: 'SETUP', message: err.message });
    console.log(`\n  SETUP ERROR: ${err.message}\n${err.stack}`);
  } finally {
    server.close();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  }
  process.exit(failures.length ? 1 : 0);
})();
