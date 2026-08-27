// End-to-end check of rectangle merging and splitting, against a real Postgres.
//
// Connects as argus_app, NOT the migration owner — RLS is silently bypassed for
// table owners. Run against a throwaway database only; it writes freely.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/cells-merge-e2e.js
//
// The stock-preservation cases are the point of this file. cell_stock hangs off
// cell_blocks with ON DELETE CASCADE, so any merge implemented as
// delete-both-then-insert erases the record of goods that are still sitting on
// the shelf. That bug shipped once; these checks exist so it can't come back.

const assert = require('node:assert');
const { createApp } = require('../src/app');

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
        name: 'Merge Owner',
        email: `merge${stamp}@test.local`,
        password: 'secret123',
        warehouseName: 'Merge Warehouse',
        city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, `register: ${JSON.stringify(reg.body)}`);
    const ownerToken = reg.body.token;

    const company = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Alpha' },
    });
    const companyId = company.body.id;

    const staff = await api('POST', '/api/staff', {
      token: ownerToken, body: { name: 'Worker' },
    });
    const workerLogin = await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    });
    const workerToken = workerLogin.body.token;

    // One row, 4 racks x 3 tiers = 12 atomic cells to carve up.
    const layout = await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 4, tierCount: 3 }] },
    });
    assert.equal(layout.status, 201, `layout: ${JSON.stringify(layout.body)}`);

    async function getRow() {
      const rows = await api('GET', '/api/cells/rows', { token: ownerToken });
      return rows.body[0];
    }
    const blockAt = (row, rack, tier) => row.blocks.find((b) => (
      b.rack_start <= rack && b.rack_end >= rack
      && b.tier_start <= tier && b.tier_end >= tier
    ));

    async function receiveInto(cellBlockId, sku, qty, num) {
      const inv = await api('POST', '/api/invoices', {
        token: ownerToken,
        body: {
          companyId, number: `IN-${num}`, direction: 'in',
          items: [{ name: 'Widget', sku, declaredQty: qty }],
        },
      });
      assert.equal(inv.status, 201, `invoice: ${JSON.stringify(inv.body)}`);
      const rec = await api('POST', '/api/receiving', {
        token: workerToken,
        body: { invoiceItemId: inv.body.items[0].id, acceptedQty: qty, cellBlockId },
      });
      assert.equal(rec.status, 201, `receiving: ${JSON.stringify(rec.body)}`);
    }

    console.log('\nRectangle merge\n');

    // ---------- Plain 2x2 merge of empty cells ----------
    const merge2x2 = await api('POST', '/api/cells/blocks/merge-rect', {
      token: ownerToken,
      body: { rowNum: 1, rackStart: 1, rackEnd: 2, tierStart: 1, tierEnd: 2 },
    });
    check('2x2 merge succeeds', () => assert.equal(merge2x2.status, 201, JSON.stringify(merge2x2.body)));
    check('2x2 merge spans the whole rectangle', () => {
      const b = merge2x2.body;
      assert.equal(b.rack_start, 1); assert.equal(b.rack_end, 2);
      assert.equal(b.tier_start, 1); assert.equal(b.tier_end, 2);
    });

    let row = await getRow();
    check('2x2 merge collapsed 4 blocks into 1', () => {
      // 12 atomic cells - 4 absorbed + 1 merged = 9
      assert.equal(row.blocks.length, 9, `got ${row.blocks.length} blocks`);
    });

    // ---------- Rejections ----------
    const single = await api('POST', '/api/cells/blocks/merge-rect', {
      token: ownerToken,
      body: { rowNum: 1, rackStart: 4, rackEnd: 4, tierStart: 3, tierEnd: 3 },
    });
    check('single cell is not a merge', () => assert.equal(single.status, 400, JSON.stringify(single.body)));

    // Rack 2 tier 2 is inside the 2x2 block; racks 2-3 tier 2 cuts it in half.
    const cuts = await api('POST', '/api/cells/blocks/merge-rect', {
      token: ownerToken,
      body: { rowNum: 1, rackStart: 2, rackEnd: 3, tierStart: 2, tierEnd: 2 },
    });
    check('selection cutting a merged block is refused', () => {
      assert.equal(cuts.status, 400, JSON.stringify(cuts.body));
    });
    check('refusal explains what to do', () => {
      assert.match(cuts.body.error, /целиком/, `unhelpful message: ${cuts.body.error}`);
    });

    const outside = await api('POST', '/api/cells/blocks/merge-rect', {
      token: ownerToken,
      body: { rowNum: 1, rackStart: 3, rackEnd: 9, tierStart: 1, tierEnd: 2 },
    });
    check('rectangle past the end of the row is refused', () => {
      assert.equal(outside.status, 400, JSON.stringify(outside.body));
    });

    const badRow = await api('POST', '/api/cells/blocks/merge-rect', {
      token: ownerToken,
      body: { rowNum: 99, rackStart: 1, rackEnd: 2, tierStart: 1, tierEnd: 1 },
    });
    check('unknown row is refused', () => assert.equal(badRow.status, 404, JSON.stringify(badRow.body)));

    // ---------- Swallowing an already-merged block whole ----------
    const swallow = await api('POST', '/api/cells/blocks/merge-rect', {
      token: ownerToken,
      body: { rowNum: 1, rackStart: 1, rackEnd: 3, tierStart: 1, tierEnd: 2 },
    });
    check('rectangle containing a merged block whole is allowed', () => {
      assert.equal(swallow.status, 201, JSON.stringify(swallow.body));
    });

    console.log('\nStock survival\n');

    // ---------- Merge must carry stock, not cascade it away ----------
    row = await getRow();
    const target = blockAt(row, 4, 1);           // untouched atomic cell
    await receiveInto(target.id, 'SKU-KEEP', 25, `${stamp}-keep`);

    row = await getRow();
    const beforeMerge = blockAt(row, 4, 1);
    check('goods landed in the cell', () => {
      assert.equal(beforeMerge.stock.length, 1, JSON.stringify(beforeMerge.stock));
      assert.equal(beforeMerge.stock[0].qty, 25);
    });

    const mergeOccupied = await api('POST', '/api/cells/blocks/merge-rect', {
      token: ownerToken,
      body: { rowNum: 1, rackStart: 4, rackEnd: 4, tierStart: 1, tierEnd: 2 },
    });
    check('merging an occupied cell succeeds', () => {
      assert.equal(mergeOccupied.status, 201, JSON.stringify(mergeOccupied.body));
    });

    row = await getRow();
    const afterMerge = blockAt(row, 4, 1);
    check('goods survived the merge', () => {
      assert.equal(afterMerge.stock.length, 1, `stock lost: ${JSON.stringify(afterMerge.stock)}`);
      assert.equal(afterMerge.stock[0].sku, 'SKU-KEEP');
      assert.equal(afterMerge.stock[0].qty, 25);
    });
    check('merged cell reads as occupied', () => assert.equal(afterMerge.state, 'occupied'));

    console.log('\nSplit\n');

    // ---------- Splitting an occupied block is refused ----------
    const splitOccupied = await api('POST', `/api/cells/blocks/${afterMerge.id}/split`, {
      token: ownerToken,
    });
    check('splitting an occupied cell is refused', () => {
      assert.equal(splitOccupied.status, 409, JSON.stringify(splitOccupied.body));
    });
    row = await getRow();
    check('refused split changed nothing', () => {
      const still = blockAt(row, 4, 1);
      assert.equal(still.stock.length, 1, 'stock disappeared on a refused split');
      assert.equal(still.rack_start, 4);
      assert.equal(still.tier_end, 2);
    });

    // ---------- Splitting an empty block works ----------
    const emptyMerged = row.blocks.find((b) => (
      b.state !== 'occupied' && (b.rack_end > b.rack_start || b.tier_end > b.tier_start)
    ));
    assert.ok(emptyMerged, 'expected an empty merged block to split');
    const splitEmpty = await api('POST', `/api/cells/blocks/${emptyMerged.id}/split`, {
      token: ownerToken,
    });
    check('splitting an empty cell succeeds', () => {
      assert.equal(splitEmpty.status, 201, JSON.stringify(splitEmpty.body));
    });
    check('split returns one cell per rack/tier', () => {
      const expected = (emptyMerged.rack_end - emptyMerged.rack_start + 1)
        * (emptyMerged.tier_end - emptyMerged.tier_start + 1);
      assert.equal(splitEmpty.body.length, expected);
    });
    check('split cells are all 1x1', () => {
      const bad = splitEmpty.body.find((b) => b.rack_start !== b.rack_end || b.tier_start !== b.tier_end);
      assert.ok(!bad, `not atomic: ${JSON.stringify(bad)}`);
    });

    // ---------- The removed endpoint stays removed ----------
    const oldMerge = await api('POST', '/api/cells/blocks/merge', {
      token: ownerToken, body: { blockAId: afterMerge.id, blockBId: afterMerge.id },
    });
    check('old pairwise merge endpoint is gone', () => {
      assert.equal(oldMerge.status, 404, `still reachable: ${JSON.stringify(oldMerge.body)}`);
    });

  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.log(`  FAILED: ${f.name} — ${f.message}`));
    process.exit(1);
  }
})().catch((err) => {
  console.error('\nSuite crashed:', err);
  process.exit(1);
});
