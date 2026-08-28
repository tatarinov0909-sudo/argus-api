// End-to-end check of warehouse size limits and custom names for rows/zones.
//
// Connects as argus_app, NOT the migration owner — RLS is silently bypassed for
// table owners. Run against a throwaway database only; it writes freely.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/naming-limits-e2e.js
//
// A row's name becomes the first part of every cell address (`1.3.4` turns into
// `А.3.4`), which is why names are short and must be unique — two rows called
// "А" would make addresses ambiguous and the Кладовщик agent would point a
// worker at the wrong shelf. The uniqueness checks below guard exactly that.

const assert = require('node:assert');
const { createApp } = require('../src/app');

const PORT = 3996;
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
        name: 'Naming Owner',
        email: `naming${stamp}@test.local`,
        password: 'secret123',
        warehouseName: 'Naming Warehouse',
        city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, `register: ${JSON.stringify(reg.body)}`);
    const token = reg.token || reg.body.token;

    console.log('\nSize limits\n');

    // ---------- More than 10 tiers must now be allowed ----------
    const tall = await api('POST', '/api/cells/rows', {
      token, body: { configs: [{ rackCount: 4, tierCount: 18 }] },
    });
    check('18 tiers is accepted (the old cap of 10 was arbitrary)', () => {
      assert.equal(tall.status, 201, JSON.stringify(tall.body));
    });

    const wide = await api('POST', '/api/cells/rows', {
      token, body: { configs: [{ rackCount: 120, tierCount: 6 }, { rackCount: 6, tierCount: 4 }] },
    });
    check('120 racks in a row is accepted', () => {
      assert.equal(wide.status, 201, JSON.stringify(wide.body));
    });

    // ---------- ...but a typo must not reach the database ----------
    const absurdTiers = await api('POST', '/api/cells/rows', {
      token, body: { configs: [{ rackCount: 4, tierCount: 5000 }] },
    });
    check('5000 tiers is refused', () => assert.equal(absurdTiers.status, 400, JSON.stringify(absurdTiers.body)));
    check('the refusal names the tier limit', () => {
      assert.match(absurdTiers.body.error, /ярус/i, absurdTiers.body.error);
    });

    const absurdRacks = await api('POST', '/api/cells/rows', {
      token, body: { configs: [{ rackCount: 9000, tierCount: 4 }] },
    });
    check('9000 racks is refused', () => assert.equal(absurdRacks.status, 400, JSON.stringify(absurdRacks.body)));

    // Each row is under its own cap, but together they would be millions of cells.
    const manyRows = await api('POST', '/api/cells/rows', {
      token, body: { configs: Array.from({ length: 40 }, () => ({ rackCount: 190, tierCount: 28 })) },
    });
    check('a total that is huge only in aggregate is refused', () => {
      assert.equal(manyRows.status, 400, JSON.stringify(manyRows.body));
    });

    const tooManyRows = await api('POST', '/api/cells/rows', {
      token, body: { configs: Array.from({ length: 200 }, () => ({ rackCount: 1, tierCount: 1 })) },
    });
    check('200 rows is refused', () => assert.equal(tooManyRows.status, 400, JSON.stringify(tooManyRows.body)));

    const zonesOk = await api('POST', '/api/dropzones', { token, body: { count: 24 } });
    check('24 zones is accepted (the old cap of 10 was arbitrary)', () => {
      assert.equal(zonesOk.status, 201, JSON.stringify(zonesOk.body));
    });
    const zonesTooMany = await api('POST', '/api/dropzones', { token, body: { count: 500 } });
    check('500 zones is refused', () => assert.equal(zonesTooMany.status, 400, JSON.stringify(zonesTooMany.body)));

    console.log('\nNames\n');

    // Rebuild something small to name.
    await api('POST', '/api/cells/rows', {
      token, body: { configs: [{ rackCount: 3, tierCount: 2 }, { rackCount: 3, tierCount: 2 }] },
    });
    await api('POST', '/api/dropzones', { token, body: { count: 2 } });

    const named = await api('PATCH', '/api/cells/rows/1/name', { token, body: { label: 'А' } });
    check('a row can be named', () => assert.equal(named.status, 200, JSON.stringify(named.body)));
    check('the name comes back', () => assert.equal(named.body.label, 'А'));

    const rows = await api('GET', '/api/cells/rows', { token });
    check('the name is in the layout', () => {
      assert.equal(rows.body.find((r) => r.row_num === 1).label, 'А');
      assert.equal(rows.body.find((r) => r.row_num === 2).label, null);
    });

    const tooLong = await api('PATCH', '/api/cells/rows/2/name', { token, body: { label: 'Стеллажи у ворот' } });
    check('a long name is refused', () => assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body)));
    check('the refusal explains why it must be short', () => {
      assert.match(tooLong.body.error, /адрес/i, tooLong.body.error);
    });

    const fourChars = await api('PATCH', '/api/cells/rows/2/name', { token, body: { label: 'АБВГ' } });
    check('exactly four characters is allowed', () => assert.equal(fourChars.status, 200, JSON.stringify(fourChars.body)));

    const withDot = await api('PATCH', '/api/cells/rows/2/name', { token, body: { label: 'А.1' } });
    check('a dot in the name is refused', () => {
      assert.equal(withDot.status, 400, JSON.stringify(withDot.body));
    });

    const duplicate = await api('PATCH', '/api/cells/rows/2/name', { token, body: { label: 'А' } });
    check('a name already taken by another row is refused', () => {
      assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    });
    const dupeCase = await api('PATCH', '/api/cells/rows/2/name', { token, body: { label: 'а' } });
    check('the same name in another case is refused too', () => {
      assert.equal(dupeCase.status, 409, JSON.stringify(dupeCase.body));
    });

    const renameSelf = await api('PATCH', '/api/cells/rows/1/name', { token, body: { label: 'А' } });
    check('a row can keep its own name', () => assert.equal(renameSelf.status, 200, JSON.stringify(renameSelf.body)));

    const cleared = await api('PATCH', '/api/cells/rows/1/name', { token, body: { label: '  ' } });
    check('an empty name clears back to the number', () => {
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      assert.equal(cleared.body.label, null);
    });
    const nowFree = await api('PATCH', '/api/cells/rows/2/name', { token, body: { label: 'А' } });
    check('a freed name can be taken by another row', () => {
      assert.equal(nowFree.status, 200, JSON.stringify(nowFree.body));
    });

    const missingRow = await api('PATCH', '/api/cells/rows/99/name', { token, body: { label: 'Я' } });
    check('naming a row that does not exist is refused', () => {
      assert.equal(missingRow.status, 404, JSON.stringify(missingRow.body));
    });

    // ---------- Zones ----------
    const zones = await api('GET', '/api/dropzones', { token });
    check('fresh zones carry no auto-generated name', () => {
      assert.equal(zones.body[0].label, null, JSON.stringify(zones.body[0]));
    });

    const zoneNamed = await api('PATCH', `/api/dropzones/${zones.body[0].id}/name`, {
      token, body: { label: 'ПРМ' },
    });
    check('a zone can be named', () => assert.equal(zoneNamed.status, 200, JSON.stringify(zoneNamed.body)));

    const zoneDupe = await api('PATCH', `/api/dropzones/${zones.body[1].id}/name`, {
      token, body: { label: 'прм' },
    });
    check('a duplicate zone name is refused', () => {
      assert.equal(zoneDupe.status, 409, JSON.stringify(zoneDupe.body));
    });

    // A row and a zone may share a name: they live in different namespaces and
    // a cell address never contains a zone.
    const sameAsRow = await api('PATCH', `/api/dropzones/${zones.body[1].id}/name`, {
      token, body: { label: 'А' },
    });
    check('a zone may reuse a row name', () => assert.equal(sameAsRow.status, 200, JSON.stringify(sameAsRow.body)));

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
