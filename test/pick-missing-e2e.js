// Отметка грузчика «нет товара» со сборки: уходит «очень важно» владельцу и
// менеджеру с правом, видна в поставке, остаток не трогает. Только на
// отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Pick missing E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');

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
    const reg = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Missing test', email: `pick-missing-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Missing test', city: 'Test',
    }), 201);
    const owner = reg.token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Слим Тест' }), 201).id;
    must(await api('POST', '/api/products', owner, { sku: 'PB-1', name: 'Батончик', companyId: company }), 201);
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 2, tierCount: 1 }] }), 201);
    const cell = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks)[0].id;
    const staff = must(await api('POST', '/api/staff', owner, { name: 'Грузчик Иван' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code })).token;
    const plainMgr = must(await api('POST', '/api/staff', owner, { name: 'Менеджер без права', kind: 'manager' }), 201);
    const plain = must(await api('POST', '/api/auth/staff/login', null, { keyCode: plainMgr.key_code })).token;
    const grantedMgr = must(await api('POST', '/api/staff', owner, { name: 'Менеджер с правом', kind: 'manager', permissions: ['shortages'] }), 201);
    const granted = must(await api('POST', '/api/auth/staff/login', null, { keyCode: grantedMgr.key_code })).token;

    // Товар на полке: 3 шт.
    const receipt = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'IN-1',
      items: [{ sku: 'PB-1', name: 'Батончик', declaredQty: 3 }] }), 201);
    must(await api('POST', '/api/receiving', worker, { invoiceItemId: receipt.items[0].id, acceptedQty: 3, cellBlockId: cell }), 201);

    // Заказ WB на 5 шт. в поставке.
    const order = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'WB-900001', direction: 'out',
      items: [{ sku: 'PB-1', name: 'Батончик', declaredQty: 5 }] }), 201);
    await run((c) => c.query(`UPDATE invoices SET source = 'wb', external_id = '900001', mp_supplier_status = 'new' WHERE id = $1`, [order.id]));
    await run((c) => c.query(`UPDATE invoice_items SET mp_rid = 'rid-900001' WHERE invoice_id = $1`, [order.id]));
    const supply = must(await api('POST', '/api/supplies', owner, { invoiceIds: [order.id], marketplace: 'wb' }), 201);
    const itemId = order.items[0].id;
    const stockBefore = await run((c) => c.query('SELECT SUM(qty)::int AS q FROM cell_stock WHERE warehouse_id = $1', [warehouseId]));
    const outboxBefore = await run((c) => c.query('SELECT count(*)::int AS n FROM sync_outbox WHERE warehouse_id = $1', [warehouseId]));

    // ---------- Отметка ----------
    const byOwner = await api('POST', '/api/shipping/missing', owner, { invoiceItemId: itemId, missingQty: 2 });
    const zero = await api('POST', '/api/shipping/missing', worker, { invoiceItemId: itemId, missingQty: 0 });
    const tooMany = await api('POST', '/api/shipping/missing', worker, { invoiceItemId: itemId, missingQty: 6 });
    check('отмечает только грузчик; ноль и больше остатка — отказ', () => {
      assert.equal(byOwner.status, 403); assert.equal(zero.status, 400); assert.equal(tooMany.status, 400);
    });
    const marked = must(await api('POST', '/api/shipping/missing', worker, {
      invoiceItemId: itemId, missingQty: 2, note: 'на полке  только 3,\nостальное не нашёл',
    }), 201);
    check('отметка — «очень важно», ждёт решения, с заказом, поставкой и грузчиком', () => {
      assert.equal(marked.entry.urgent, true);
      assert.equal(marked.entry.status, 'pending');
      assert.match(marked.entry.action_text, /^ОЧЕНЬ ВАЖНО: нет товара «Батончик» \(PB-1\) — не хватает 2 из 5 шт\./);
      assert.match(marked.entry.action_text, new RegExp(`поставка «${supply.number}»`));
      assert.match(marked.entry.action_text, /Отметил Грузчик Иван/);
      assert.match(marked.entry.action_text, /Комментарий: на полке только 3, остальное не нашёл$/);
    });
    const again = must(await api('POST', '/api/shipping/missing', worker, { invoiceItemId: itemId, missingQty: 2 }));
    check('второе нажатие — та же отметка, не вторая тревога', () => {
      assert.equal(again.repeated, true); assert.equal(again.entry.id, marked.entry.id);
    });
    const stockAfter = await run((c) => c.query('SELECT SUM(qty)::int AS q FROM cell_stock WHERE warehouse_id = $1', [warehouseId]));
    const outboxAfter = await run((c) => c.query('SELECT count(*)::int AS n FROM sync_outbox WHERE warehouse_id = $1', [warehouseId]));
    check('отметка не трогает остаток и ничего не шлёт в 1С', () => {
      assert.equal(stockAfter.rows[0].q, stockBefore.rows[0].q);
      assert.equal(outboxAfter.rows[0].n, outboxBefore.rows[0].n);
    });

    // ---------- Кто видит ----------
    const ownerFeed = must(await api('GET', '/api/journal', owner));
    const plainFeed = must(await api('GET', '/api/journal', plain));
    const grantedFeed = must(await api('GET', '/api/journal', granted));
    check('владелец и менеджер с правом видят отметку в журнале, менеджер без права — нет', () => {
      const e = ownerFeed.find((x) => x.id === marked.entry.id);
      assert.equal(e.urgent, true); assert.equal(e.answered, false);
      assert.ok(grantedFeed.some((x) => x.id === marked.entry.id));
      assert.ok(!plainFeed.some((x) => x.id === marked.entry.id));
    });
    const ownerList = must(await api('GET', '/api/supplies', owner)).find((s) => s.id === supply.id);
    const plainList = must(await api('GET', '/api/supplies', plain)).find((s) => s.id === supply.id);
    const ownerInside = must(await api('GET', `/api/supplies/${supply.id}`, owner));
    const plainInside = must(await api('GET', `/api/supplies/${supply.id}`, plain));
    const grantedInside = must(await api('GET', `/api/supplies/${supply.id}`, granted));
    check('в поставке: метка «нет товара» и сама отметка — владельцу и менеджеру с правом', () => {
      assert.equal(ownerList.missing, 1);
      assert.equal(plainList.missing, null);
      assert.equal(ownerInside.shortages.length, 1);
      assert.equal(ownerInside.shortages[0].orderNumber, 'WB-900001');
      assert.equal(grantedInside.shortages.length, 1);
      assert.equal(plainInside.shortages.length, 0);
    });
    const onScreen = must(await api('GET', `/api/invoices/${order.id}`, worker));
    check('экран сборки знает, что позиция уже отмечена', () => {
      assert.equal(onScreen.items[0].missing_marked, true);
    });

    // ---------- Решение ----------
    const plainResolve = await api('POST', `/api/journal/${marked.entry.id}/resolve`, plain, { resolution: 'confirm' });
    check('менеджер без права отметку не решает', () => assert.equal(plainResolve.status, 403));
    must(await api('POST', `/api/journal/${marked.entry.id}/resolve`, granted, { resolution: 'confirm', note: 'Уберём заказ из поставки' }), 201);
    const feedAfter = must(await api('GET', '/api/journal', owner));
    const listAfter = must(await api('GET', '/api/supplies', owner)).find((s) => s.id === supply.id);
    const insideAfter = must(await api('GET', `/api/supplies/${supply.id}`, owner));
    const screenAfter = must(await api('GET', `/api/invoices/${order.id}`, worker));
    check('после ответа отметка гаснет: в журнале «отвечено», в поставке пусто', () => {
      assert.equal(feedAfter.find((x) => x.id === marked.entry.id).answered, true);
      assert.equal(listAfter.missing, 0);
      assert.equal(insideAfter.shortages.length, 0);
      assert.equal(screenAfter.items[0].missing_marked, false);
    });

    // ---------- Закрытая позиция ----------
    must(await api('POST', '/api/shipping', worker, { invoiceItemId: itemId, pickedQty: 3, cellBlockId: cell, isFinal: true }), 201);
    const closed = await api('POST', '/api/shipping/missing', worker, { invoiceItemId: itemId, missingQty: 1 });
    check('по закрытой позиции отмечать нечего', () => assert.equal(closed.status, 409));

    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error('FAIL', e);
    process.exitCode = 1;
  } finally {
    server.close();
    await require('../src/db/pool').pool.end();
  }
})();
