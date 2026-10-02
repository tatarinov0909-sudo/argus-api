// Разбор Кладовщика 02.10.2026, ошибки 1–7: цифры в чате — как в кабинете
// продавца; работа склада (сводка и «состояние склада») — как у грузчика;
// напоминание «собрано и не уехало» — про поставки и отгрузки 1С; «ждёт
// решения» — без решённого; список приходов — без заказов поставщику;
// поиск по карте склада — и у менеджера с правом «склад». Только на
// отдельной тестовой базе.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const kladovshchik = require('../src/agents/kladovshchik');
const rules = require('../src/alerts/rules');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const api = async (method, path, token, body, status = 200) => {
    const r = await call(method, path, token, body);
    assert.equal(r.status, status, `${method} ${path}: ${r.status} ${r.body && r.body.error || ''}`);
    return r.body;
  };
  let passed = 0;
  const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
  try {
    const owner = (await api('POST', '/api/auth/owner/register', null, {
      name: 'Разбор', email: `klad-review-${Date.now()}@example.test`, password: 'test-only-password', warehouseName: 'Разбор', city: 'Test',
    }, 201)).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const db = (sql, args) => run((c) => c.query(sql, args));
    const company = (await api('POST', '/api/sellers/companies', owner, { name: 'Слим Разбор' }, 201)).id;
    await api('POST', '/api/products', owner, { sku: 'KR-1', name: 'Гранола', companyId: company }, 201);
    await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 3, tierCount: 1 }] }, 201);
    const cells = (await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const key = await api('POST', '/api/staff', owner, { name: 'Грузчик' }, 201);
    const worker = (await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;

    // Приняли 10, из них 8 — расхождение с заявленными 12.
    const receipt = await api('POST', '/api/invoices', owner, { companyId: company, number: 'KR-IN',
      items: [{ sku: 'KR-1', name: 'Гранола', declaredQty: 12 }] }, 201);
    await api('POST', `/api/receiving/session/${receipt.id}/start`, worker, {}, 201);
    await api('POST', '/api/receiving', worker, { invoiceItemId: receipt.items[0].id, acceptedQty: 10, cellBlockId: cells[0].id }, 201);
    await db("UPDATE products SET stock_qty_1c = 20, stock_at = now() WHERE company_id = $1 AND sku = 'KR-1'", [company]);

    // Заказы WB: 3 шт. без поставки («Заказано») и 2 шт. в поставке («В сборке»).
    const order = async (number, qty) => {
      const o = await api('POST', '/api/invoices', owner, { companyId: company, number, direction: 'out',
        items: [{ sku: 'KR-1', name: 'Гранола', declaredQty: qty }] }, 201);
      await db("UPDATE invoices SET source = 'wb', external_id = $2 WHERE id = $1", [o.id, number]);
      await db("UPDATE invoice_items SET mp_rid = 'rid-' || id WHERE invoice_id = $1", [o.id]);
      return o;
    };
    const queued = await order('WB-KR-1', 3);
    const inSupply = await order('WB-KR-2', 2);
    const supply = await api('POST', '/api/supplies', owner, { invoiceIds: [inSupply.id], marketplace: 'wb' }, 201);

    // ---- 1. Цифры как в кабинете продавца ----
    const cabinet = (await api('GET', `/api/sellers/stock?companyId=${company}&view=seller`, owner)).rows.find((r) => r.sku === 'KR-1');
    const agent = (await run((c) => kladovshchik.findProducts(c, warehouseId, 'KR-1')))[0];
    assert.deepEqual(
      [agent.stock.total, agent.stock.ordered, agent.stock.inAssembly, agent.stock.inTransit, agent.stock.available],
      [cabinet.total, cabinet.ordered, cabinet.inAssembly, cabinet.inTransit, cabinet.available]);
    assert.deepEqual([agent.stock.total, agent.stock.ordered, agent.stock.inAssembly, agent.stock.available], [20, 3, 2, 15]);
    assert.equal(agent.seller, 'Слим Разбор');
    assert.equal(agent.totalQty, 10, 'по ячейкам — как было');
    const forMap = (await run((c) => kladovshchik.findProducts(c, warehouseId, 'KR-1', { withId: true })))[0];
    assert.equal(forMap.companyId, company); assert.equal(forMap.stock, undefined);
    check('find_products: «Всего / Заказано / В сборке / Доступно» — те же, что в кабинете продавца');

    // ---- 4. «Ждёт решения» — без решённого ----
    let waiting = await run((c) => kladovshchik.listDiscrepancies(c, warehouseId, {}));
    assert.equal(waiting.length, 1, JSON.stringify(waiting));
    const pending = (await db("SELECT id FROM journal_entries WHERE warehouse_id = $1 AND status = 'pending'", [warehouseId])).rows[0];
    await api('POST', `/api/journal/${pending.id}/resolve`, owner, { resolution: 'confirm' }, 201);
    waiting = await run((c) => kladovshchik.listDiscrepancies(c, warehouseId, {}));
    assert.equal(waiting.length, 0, JSON.stringify(waiting));
    check('list_discrepancies: решённое больше не «ждёт решения»');

    // ---- 5. Приходы без заказов поставщику; заказ WB вне поставки назван честно ----
    const supplierOrder = await api('POST', '/api/invoices', owner, { companyId: company, number: 'ЗП-1С-1',
      items: [{ sku: 'KR-1', name: 'Гранола', declaredQty: 100 }] }, 201);
    await db("UPDATE invoices SET source = '1c', source_document_type = 'supplier_order' WHERE id = $1", [supplierOrder.id]);
    const ins = await run((c) => kladovshchik.listInvoices(c, warehouseId, { direction: 'in' }));
    assert.ok(!ins.some((i) => i.number === 'ЗП-1С-1'), JSON.stringify(ins));
    const outs = await run((c) => kladovshchik.listInvoices(c, warehouseId, { direction: 'out' }));
    assert.equal(outs.find((i) => i.number === 'WB-KR-1').status, 'заказан на WB, в поставку ещё не взят');
    assert.equal(outs.find((i) => i.number === 'WB-KR-2').supply, supply.number);
    check('list_invoices: заказ поставщику из 1С — не привоз; заказ WB без поставки — «в поставку ещё не взят»');

    // ---- 2 и 6. Работа склада — как у грузчика ----
    const arrived = await api('POST', '/api/invoices', owner, { companyId: company, number: 'KR-IN-2',
      items: [{ sku: 'KR-1', name: 'Гранола', declaredQty: 5 }] }, 201);
    await db('UPDATE invoices SET arrived_at = now() WHERE id = $1', [arrived.id]);
    const onec = await api('POST', '/api/invoices', owner, { companyId: company, number: '1С-ОТГ-1', direction: 'out',
      items: [{ sku: 'KR-1', name: 'Гранола', declaredQty: 1 }] }, 201);
    await db("UPDATE invoices SET source = '1c' WHERE id = $1", [onec.id]);
    await api('POST', '/api/invoices', owner, { companyId: company, number: 'KR-RET', direction: 'return',
      items: [{ sku: 'KR-1', name: 'Гранола', declaredQty: 1 }] }, 201);
    await db(`INSERT INTO defect_decisions (warehouse_id, company_id, number, sku, name, bucket, qty, action, decided_role)
              VALUES ($1, $2, 'РБ-T-1', 'KR-1', 'Гранола', 'defective', 1, 'dispose', 'seller')`, [warehouseId, company]);
    const work = await run((c) => kladovshchik.workQueue(c, warehouseId));
    assert.deepEqual(work, { suppliesToPick: 1, ordersToPick: 1, onecToPick: 1, suppliesReady: 0,
      toReceive: 1, arrived: 1, returnsToSort: 1, defectTasks: 1 });
    const summary = await run((c) => kladovshchik.warehouseSummary(c, warehouseId));
    assert.deepEqual(summary.work, work); assert.equal(summary.openDocuments, undefined);
    void queued;
    check('работа склада: поставки и заказы в них, 1С, привозы без заказов поставщику, возвраты, задания брака');

    // ---- 3. «Собрано и не уехало» — про поставки и отгрузки 1С ----
    await db("UPDATE invoices SET status = 'ready', created_at = now() - interval '2 days' WHERE id = $1", [inSupply.id]);
    let found = await run((c) => rules.collect(c, warehouseId));
    assert.ok(!found.some((f) => f.key === 'ready_not_shipped' || f.key === 'supply_ready_not_shipped'), JSON.stringify(found));
    await db("UPDATE supplies SET status = 'ready', ready_at = now() - interval '10 hours' WHERE id = $1", [supply.id]);
    await db("UPDATE invoices SET status = 'ready', created_at = now() - interval '2 days' WHERE id = $1", [onec.id]);
    found = await run((c) => rules.collect(c, warehouseId));
    assert.match(found.find((f) => f.key === 'supply_ready_not_shipped').text, new RegExp(`Поставка ${supply.number} \\(Слим Разбор\\) собрана, но не уехала`));
    assert.match(found.find((f) => f.key === 'ready_not_shipped').text, /Отгрузка 1С-ОТГ-1 из 1С/);
    check('напоминание: собранный заказ в несобранной поставке — не тревога; собранная поставка и отгрузка 1С — тревога');

    // ---- 7. Поиск по карте склада у менеджера ----
    const mgr = async (permissions) => {
      const k = await api('POST', '/api/staff', owner, { name: 'Менеджер', kind: 'manager', permissions }, 201);
      return (await api('POST', '/api/auth/staff/login', null, { keyCode: k.key_code })).token;
    };
    await api('GET', '/api/agents/kladovshchik/find?q=KR-1', await mgr(['warehouse']), undefined, 200);
    await api('GET', '/api/agents/kladovshchik/find?q=KR-1', await mgr([]), undefined, 403);
    check('поиск по карте склада: менеджер с правом «склад» — да, без права — нет');

    console.log(`\n${passed} checks passed`);
  } finally {
    await new Promise((r) => server.close(r)); await pool.end();
  }
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
