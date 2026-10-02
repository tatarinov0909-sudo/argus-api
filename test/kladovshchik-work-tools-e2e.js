// Новые умения Кладовщика (владелец 02.10.2026, вариант «а»): «поставки» и
// «что на складе сейчас» (кто что делает, привозы, склад брака); «подобрать
// ячейку» и «лист грузчика» из чата убраны. Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const kladovshchik = require('../src/agents/kladovshchik');
const { ALL_TOOLS } = require('../src/agents/orchestratorPrompt');
const { zoneOf, todayIn } = require('../src/warehouses/time');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, token, body, status = 200) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    assert.equal(res.status, status, `${method} ${path}: ${res.status} ${data && data.error || ''}`);
    return data;
  };
  let passed = 0;
  const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
  try {
    const owner = (await api('POST', '/api/auth/owner/register', null, {
      name: 'Сейчас', email: `klad-now-${Date.now()}@example.test`, password: 'test-only-password', warehouseName: 'Сейчас', city: 'Test',
    }, 201)).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const db = (sql, args) => run((c) => c.query(sql, args));
    const tool = (name, args = {}) => run((c) => kladovshchik.runTool(c, warehouseId, name, args));
    const today = await run(async (c) => todayIn(await zoneOf(c, warehouseId)));
    const company = (await api('POST', '/api/sellers/companies', owner, { name: 'Слим Сейчас' }, 201)).id;
    for (const [sku, name] of [['NW-1', 'Батончик'], ['NW-2', 'Паста']]) {
      await api('POST', '/api/products', owner, { sku, name, companyId: company }, 201);
    }
    await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 4, tierCount: 1 }] }, 201);
    const cells = (await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const login = async (name) => {
      const k = await api('POST', '/api/staff', owner, { name }, 201);
      return (await api('POST', '/api/auth/staff/login', null, { keyCode: k.key_code })).token;
    };
    const dima = await login('Дима');
    const ivan = await login('Иван');

    const receipt = await api('POST', '/api/invoices', owner, { companyId: company, number: 'NW-IN',
      items: [{ sku: 'NW-1', name: 'Батончик', declaredQty: 10 }, { sku: 'NW-2', name: 'Паста', declaredQty: 1 }] }, 201);
    await api('POST', `/api/receiving/session/${receipt.id}/start`, dima, {}, 201);
    await api('POST', '/api/receiving', dima, { invoiceItemId: receipt.items[0].id, acceptedQty: 10, cellBlockId: cells[0].id }, 201);
    await api('POST', '/api/receiving', dima, { invoiceItemId: receipt.items[1].id, acceptedQty: 1, cellBlockId: cells[1].id }, 201);

    // Поставка: 3 батончика и 2 пасты (пасты на складе одна).
    const order = await api('POST', '/api/invoices', owner, { companyId: company, number: 'WB-NW1', direction: 'out',
      items: [{ sku: 'NW-1', name: 'Батончик', declaredQty: 3 }, { sku: 'NW-2', name: 'Паста', declaredQty: 2 }] }, 201);
    await db("UPDATE invoices SET source = 'wb', external_id = 'WB-NW1' WHERE id = $1", [order.id]);
    await db("UPDATE invoice_items SET mp_rid = 'rid-' || id WHERE invoice_id = $1", [order.id]);
    const supply = await api('POST', '/api/supplies', owner, { invoiceIds: [order.id], marketplace: 'wb', destination: 'СЦ Тест' }, 201);
    await api('POST', `/api/shipping/assembly/${supply.id}/start`, ivan, {}, 201);
    await api('POST', '/api/shipping', ivan, { invoiceItemId: order.items.find((i) => i.sku === 'NW-1').id, pickedQty: 2, cellBlockId: cells[0].id, isFinal: false }, 201);
    await api('POST', '/api/shipping/missing', ivan, { invoiceItemId: order.items.find((i) => i.sku === 'NW-2').id, missingQty: 1 }, 201);
    await api('POST', '/api/journal/pause', ivan, { supplyId: supply.id, reason: 'обед' }, 201);

    // ---- Поставки: список ----
    const list = await tool('supplies');
    const row = list.supplies.find((s) => s.number === supply.number);
    assert.equal(list.collecting, 1);
    assert.equal(row.seller, 'Слим Сейчас'); assert.equal(row.destination, 'СЦ Тест');
    assert.deepEqual([row.assembly.who, row.assembly.status, row.assembly.pauseReason, row.assembly.done], ['Иван', 'на паузе', 'обед', '2 из 5 шт.']);
    assert.equal(row.notFoundMarks, 1);
    check('поставки: кто собирает, на паузе и почему, сколько взято, отметки «нет товара»');

    // ---- Поставки: одна по номеру ----
    const one = await tool('supplies', { number: supply.number.toLowerCase() });
    const bar = one.toTake.find((l) => l.sku === 'NW-1');
    assert.equal(bar.left, 1); assert.deepEqual(bar.cells, [{ cell: '1.1.1', take: 1 }]);
    assert.equal(one.notFound.length, 1); assert.match(one.notFound[0], /Паста/);
    assert.equal(await tool('supplies', { number: 'ПС-НЕТ' }), null);
    check('поставка по номеру: что ещё взять и откуда, «нет товара»; чужой номер — null');

    // ---- Что на складе сейчас: люди ----
    const inbound = await api('POST', '/api/invoices', owner, { companyId: company, number: 'NW-PRIVOZ',
      items: [{ sku: 'NW-1', name: 'Батончик', declaredQty: 5 }, { sku: 'NW-2', name: 'Паста', declaredQty: 5 }] }, 201);
    await db(`UPDATE invoices SET source_document_type = 'seller_inbound', source_document_date = $2,
                planned_from = '10:00', planned_to = '12:00', carrier = 'ПЭК', vehicle = 'А123ВС', boxes = 4
              WHERE id = $1`, [inbound.id, today]);
    const late = await api('POST', '/api/invoices', owner, { companyId: company, number: 'NW-LATE',
      items: [{ sku: 'NW-1', name: 'Батончик', declaredQty: 1 }] }, 201);
    await db(`UPDATE invoices SET source_document_type = 'seller_inbound', source_document_date = ($2::date - 2)::text, arrived_at = now()
              WHERE id = $1`, [late.id, today]);
    const order1c = await api('POST', '/api/invoices', owner, { companyId: company, number: 'ЗП-NW',
      items: [{ sku: 'NW-1', name: 'Батончик', declaredQty: 100 }] }, 201);
    await db("UPDATE invoices SET source = '1c', external_id = 'x', source_document_type = 'supplier_order' WHERE id = $1", [order1c.id]);
    await api('POST', `/api/receiving/session/${inbound.id}/start`, dima, {}, 201);
    await api('POST', '/api/receiving', dima, { invoiceItemId: inbound.items[0].id, acceptedQty: 5, cellBlockId: cells[0].id }, 201);

    // Брак: 2 шт. ждут решения, 1 решение ждёт грузчика.
    const ret = await api('POST', '/api/returns/manual', dima, { companyId: company, items: [{ sku: 'NW-1', qty: 3 }] }, 201);
    const retItem = (await api('GET', `/api/invoices/${ret.id}`, dima)).items[0];
    await api('POST', '/api/returns', dima, { invoiceItemId: retItem.id, qty: 3, qualityBucket: 'defective', cellBlockId: cells[3].id }, 201);
    await api('POST', '/api/sellers/defects/decisions', owner, { companyId: company, sku: 'NW-1', bucket: 'defective', qty: 1, action: 'dispose' }, 201);

    const now = await tool('work_now');
    assert.equal(now.today, today);
    const people = Object.fromEntries(now.people.map((p) => [p.doing, p]));
    assert.deepEqual([people[`сборка поставки ${supply.number}`].who, people[`сборка поставки ${supply.number}`].status], ['Иван', 'на паузе']);
    assert.deepEqual([people['приёмка прихода NW-PRIVOZ'].who, people['приёмка прихода NW-PRIVOZ'].done], ['Дима', '1 из 2 позиций']);
    check('сейчас: кто что делает — сборка на паузе, приёмка идёт, сколько сделано');

    const arr = Object.fromEntries(now.arrivals.map((a) => [a.number, a]));
    assert.ok(!arr['ЗП-NW'], 'заказ поставщику — не привоз');
    assert.equal(arr['NW-PRIVOZ'].state, 'принимается');
    assert.deepEqual([arr['NW-PRIVOZ'].unloadWindow, arr['NW-PRIVOZ'].carrier, arr['NW-PRIVOZ'].boxes, arr['NW-PRIVOZ'].from], ['10:00–12:00', 'ПЭК', 4, 'привоз продавца']);
    assert.equal(arr['NW-LATE'].state, 'машина приехала, приёмку не начали');
    assert.equal(now.arrivals[0].number, 'NW-LATE', 'приехавшие — первыми');
    check('сейчас: привозы — окно выгрузки, перевозчик, приехала ли машина, идёт ли приёмка; без заказов поставщику');

    assert.deepEqual(now.defect.waitingDecision.map((w) => [w.seller, w.qty]), [['Слим Сейчас', 2]]);
    assert.deepEqual(now.defect.tasks, [{ action: 'утилизировать', count: 1, units: 1 }]);
    check('сейчас: склад брака — сколько ждёт решения у продавца и задания грузчику');

    // ---- Убранное из чата ----
    assert.deepEqual(ALL_TOOLS.map((t) => t.name).sort(),
      ['find_products', 'invoice_details', 'list_discrepancies', 'list_invoices', 'supplies', 'warehouse_summary', 'work_now']);
    assert.deepEqual(await tool('suggest_cell', { sku: 'NW-1' }), { error: 'неизвестный инструмент' });
    assert.deepEqual(await tool('pick_list'), { error: 'неизвестный инструмент' });
    check('из чата убраны «подобрать ячейку» и «лист грузчика»; инструментов по-прежнему 7');

    console.log(`\n${passed} checks passed`);
  } finally {
    await new Promise((r) => server.close(r)); await pool.end();
  }
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
