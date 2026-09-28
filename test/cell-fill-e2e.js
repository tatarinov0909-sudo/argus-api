// Заполнение ячейки по объёму (владелец 28.09.2026): размер ячейки ряда ×
// габариты товара, приблизительно; нет данных — причина, а не выдуманный
// процент. Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Cell fill E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');

(async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let passed = 0;
  const check = (label, fn) => { fn(); passed += 1; console.log(`PASS ${label}`); };
  async function api(method, path, token, body) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const must = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body; };
  try {
    const stamp = `${Date.now()}-${process.pid}`;
    const owner = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Fill test', email: `fill-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Fill test', city: 'Test',
    }), 201).token;
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Объём' }), 201).id;
    // Кубик 10 × 10 × 10 см = 1 л; у пастилы габаритов нет.
    must(await api('POST', '/api/products', owner, { sku: 'CUBE', name: 'Кубик', companyId: company,
      lengthMm: 100, widthMm: 100, heightMm: 100 }), 201);
    must(await api('POST', '/api/products', owner, { sku: 'NOSIZE', name: 'Пастила', companyId: company }), 201);
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 3, tierCount: 1 }] }), 201);
    const blocks = async () => must(await api('GET', '/api/cells/rows', owner))[0].blocks;
    const at = (list, rack) => list.find((b) => b.rack_start === rack);
    const [c1, c3] = [at(await blocks(), 1).id, at(await blocks(), 3).id];
    const key = must(await api('POST', '/api/staff', owner, { name: 'Грузчик' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
    const inv = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'ПР-ОБЪЁМ',
      items: [{ sku: 'CUBE', name: 'Кубик', declaredQty: 36 }, { sku: 'NOSIZE', name: 'Пастила', declaredQty: 5 }] }), 201);
    must(await api('POST', `/api/receiving/session/${inv.id}/start`, worker, {}), 201);
    const item = (sku) => inv.items.find((i) => i.sku === sku).id;
    must(await api('POST', '/api/receiving', worker, { invoiceItemId: item('CUBE'), acceptedQty: 36, cellBlockId: c1 }), 201);
    must(await api('POST', '/api/receiving', worker, { invoiceItemId: item('NOSIZE'), acceptedQty: 5, cellBlockId: c3 }), 201);

    const before = await blocks();
    check('размер ячеек ряда не задан — процента нет, причина «нет размера ячейки»', () => {
      assert.deepEqual(at(before, 1).fill, { pct: null, reason: 'no_cell_size' });
      assert.equal(at(before, 2).fill, null);   // пустая
    });

    const bad = await api('PATCH', '/api/cells/rows/1/cell-size', owner, { widthCm: 40, depthCm: 0, heightCm: 30 });
    const text = await api('PATCH', '/api/cells/rows/1/cell-size', owner, { widthCm: 'сорок', depthCm: 60, heightCm: 30 });
    const byWorker = await api('PATCH', '/api/cells/rows/1/cell-size', worker, { widthCm: 40, depthCm: 60, heightCm: 30 });
    check('размер — только положительные сантиметры и только тем, кто настраивает склад', () => {
      assert.equal(bad.status, 400);
      assert.equal(text.status, 400);
      assert.equal(byWorker.status, 403);
    });

    // 40 × 60 × 30 см = 72 л; 36 кубиков по литру — половина.
    must(await api('PATCH', '/api/cells/rows/1/cell-size', owner, { widthCm: 40, depthCm: 60, heightCm: '30' }));
    const sized = await blocks();
    check('36 л товара в ячейке на 72 л — 50%, свободно 36 л', () => {
      assert.deepEqual(at(sized, 1).fill, { pct: 50, freeLiters: 36 });
    });
    check('у товара нет габаритов — процента нет, названа причина и товар', () => {
      assert.deepEqual(at(sized, 3).fill, { pct: null, reason: 'no_product_size', product: 'Пастила' });
    });
    const contents = must(await api('GET', `/api/cells/blocks/${c1}/contents`, worker));
    check('карточка ячейки (и у грузчика) — тот же процент', () => {
      assert.deepEqual(contents.fill, { pct: 50, freeLiters: 36 });
    });

    // Объединили занятое место 1 с пустым 2 — объём вдвое больше.
    must(await api('POST', '/api/cells/blocks/merge-rect', owner, { rowNum: 1, rackStart: 1, rackEnd: 2, tierStart: 1, tierEnd: 1 }), 201);
    const merged = (await blocks()).find((b) => b.rack_start === 1 && b.rack_end === 2);
    check('объединённая ячейка на 2 места — 36 л из 144 л: 25%', () => {
      assert.deepEqual(merged.fill, { pct: 25, freeLiters: 108 });
    });

    must(await api('PATCH', '/api/cells/rows/1/cell-size', owner, { widthCm: null, depthCm: null, heightCm: null }));
    const cleared = (await blocks()).find((b) => b.rack_start === 1);
    check('после снятия размера — процента нет', () => assert.equal(cleared.fill.reason, 'no_cell_size'));

    console.log(`\n${passed} checks passed`);
  } finally {
    server.close();
    await require('../src/db/pool').pool.end();
  }
})().catch((err) => { console.error('FAIL', err); process.exitCode = 1; });
