// Виртуальные склады продавца (схема одобрена владельцем 02.10.2026): склады
// заводит склад; привоз по строкам на свои склады; поставка на WB — только с
// «Основного» и складов WB, собирается только товаром своего склада; перенос
// складом сразу (продавцу уведомление) или с согласия продавца, если он
// отключил право; заявка продавца — складу «очень важно»; пересчёт не
// стирает склад; брак помнит склад. Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');

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
      name: 'Склады', email: `vw-${Date.now()}@example.test`, password: 'test-only-password', warehouseName: 'Склады', city: 'Test',
    }, 201)).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const db = (sql, args) => run((c) => c.query(sql, args));
    await db("UPDATE warehouses SET stock_source = 'argus' WHERE id = $1", [warehouseId]);
    const company = (await api('POST', '/api/sellers/companies', owner, { name: 'Резинки' }, 201)).id;
    await api('POST', '/api/products', owner, { sku: 'R-1', name: 'Резинки чёрные', companyId: company }, 201);
    const key = await api('POST', `/api/sellers/companies/${company}/keys`, owner, {}, 201);
    const seller = (await api('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Продавец' })).token;
    await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 4, tierCount: 1 }] }, 201);
    const cells = (await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks).map((b) => b.id);
    const wk = await api('POST', '/api/staff', owner, { name: 'Грузчик' }, 201);
    const worker = (await api('POST', '/api/auth/staff/login', null, { keyCode: wk.key_code })).token;
    const mk = await api('POST', '/api/staff', owner, { name: 'Оля', kind: 'manager' }, 201);
    const manager = (await api('POST', '/api/auth/staff/login', null, { keyCode: mk.key_code })).token;
    const vwQty = async () => Object.fromEntries((await db(
      `SELECT COALESCE(w.name, 'Основной') AS name, SUM(cs.qty)::int AS n FROM cell_stock cs
         LEFT JOIN virtual_warehouses w ON w.id = cs.virtual_warehouse_id
        WHERE cs.company_id = $1 AND cs.quality = 'good' AND cs.qty > 0 GROUP BY 1`, [company])).rows.map((r) => [r.name, r.n]));

    // ---- Склады: заводит склад, продавец видит ----
    const ozon = await api('POST', '/api/vwarehouses', owner, { companyId: company, name: 'Озон', marketplace: 'ozon' }, 201);
    const ooo = await api('POST', '/api/vwarehouses', manager, { companyId: company, name: 'ООО БББ', marketplace: 'wb' }, 201);
    const opt = await api('POST', '/api/vwarehouses', owner, { companyId: company, name: 'Опт', marketplace: 'other' }, 201);
    await api('POST', '/api/vwarehouses', owner, { companyId: company, name: 'озон', marketplace: 'wb' }, 409);
    await api('POST', '/api/vwarehouses', owner, { companyId: company, name: 'Основной', marketplace: 'wb' }, 400);
    await api('POST', '/api/vwarehouses', owner, { companyId: company, name: 'Луна', marketplace: 'mars' }, 400);
    await api('POST', '/api/vwarehouses', seller, { companyId: company, name: 'Сам', marketplace: 'wb' }, 403);
    const seen = await api('GET', '/api/vwarehouses', seller);
    assert.deepEqual(seen.warehouses.map((w) => [w.name, w.marketplaceName]), [['Озон', 'Озон'], ['ООО БББ', 'WB'], ['Опт', 'иное']]);
    assert.deepEqual(seen.wbChoices.map((w) => w.name), ['Основной', 'ООО БББ']);
    assert.deepEqual(seen.rights, { transfer: true, shortage: true });
    const notes = await api('GET', '/api/vwarehouses/notifications', seller);
    assert.equal(notes.filter((n) => n.kind === 'vw_created').length, 3);
    check('склады заводят руководитель и менеджер; продавец видит свои склады, права и уведомления');

    // ---- Привоз продавца по строкам на свои склады ----
    const grid = [['Артикул', 'Количество', 'Склад'], ['R-1', 100, 'Озон'], ['R-1', 50, ''], ['R-1', 30, 'ооо ббб'], ['R-1', 5, 'Луна']];
    const preview = await api('POST', '/api/sellers/inbound', seller, { grid });
    assert.match(preview.lines.find((l) => l.warehouse === 'Луна').error, /склада «Луна» у вас нет/);
    // Склад, выбранный у строки в предпросмотре, — поверх столбца файла.
    assert.equal(preview.summary.products, 1);   // один товар на трёх складах — один товар
    const luna = preview.lines.find((l) => l.warehouse === 'Луна');
    const picked = await api('POST', '/api/sellers/inbound', seller, { grid, warehouseByRow: { [luna.row]: 'Опт' } });
    const lunaNow = picked.lines.find((l) => l.row === luna.row);
    assert.equal(lunaNow.error, undefined); assert.equal(lunaNow.vwName, 'Опт');
    const applied = await api('POST', '/api/sellers/inbound', seller, { grid: grid.slice(0, 4), apply: true });
    const inv = await api('GET', `/api/invoices/${applied.invoice.id}`, owner);
    const byVw = Object.fromEntries(inv.items.map((i) => [i.virtual_warehouse_id || 'main', Number(i.declared_qty)]));
    assert.deepEqual(byVw, { [ozon.id]: 100, main: 50, [ooo.id]: 30 });
    const card = await api('GET', `/api/inbound/${inv.id}`, owner);
    assert.deepEqual(card.lines.map((l) => l.vw || 'main').sort(), [ozon.id, 'main', ooo.id].sort());
    check('привоз продавца: строки ложатся на свои склады; чужой склад — ошибкой в строке');

    await api('POST', `/api/receiving/session/${inv.id}/start`, worker, {}, 201);
    for (const it of inv.items) {
      await api('POST', '/api/receiving', worker, { invoiceItemId: it.id, acceptedQty: Number(it.declared_qty), cellBlockId: cells[0] }, 201);
    }
    assert.deepEqual(await vwQty(), { 'Основной': 50, 'Озон': 100, 'ООО БББ': 30 });
    const stock = (await api('GET', `/api/sellers/stock?companyId=${company}`, owner)).find((r) => r.sku === 'R-1');
    assert.deepEqual(stock.byWarehouse.map((w) => [w.name, w.onHand, w.available]), [['Основной', 50, 50], ['Озон', 100, 100], ['ООО БББ', 30, 30], ['Опт', 0, 0]]);
    const sellerRow = (await api('GET', '/api/sellers/stock', seller)).rows.find((r) => r.sku === 'R-1');
    assert.equal(sellerRow.warehouses.length, 4);
    check('приёмка кладёт товар на склад строки; остаток по складам — и у склада, и у продавца');

    // ---- Поставка на WB: только «Основной» и склады WB ----
    const order = await api('POST', '/api/invoices', owner, { companyId: company, number: 'WB-VW1', direction: 'out',
      items: [{ sku: 'R-1', name: 'Резинки чёрные', declaredQty: 40 }] }, 201);
    await db("UPDATE invoices SET source = 'wb', external_id = 'WB-VW1' WHERE id = $1", [order.id]);
    await db("UPDATE invoice_items SET mp_rid = 'rid-' || id WHERE invoice_id = $1", [order.id]);
    const noChoice = await call('POST', '/api/supplies', owner, { invoiceIds: [order.id], marketplace: 'wb' });
    assert.equal(noChoice.status, 400); assert.match(noChoice.body.error, /«Основной», «ООО БББ»/);
    const toOzon = await call('POST', '/api/supplies', owner, { invoiceIds: [order.id], marketplace: 'wb', virtualWarehouseId: ozon.id });
    assert.equal(toOzon.status, 400); assert.match(toOzon.body.error, /Озон/);
    const supply = await api('POST', '/api/supplies', owner, { invoiceIds: [order.id], marketplace: 'wb', virtualWarehouseId: ooo.id }, 201);
    assert.equal(supply.virtualWarehouseName, 'ООО БББ');
    assert.equal((await db('SELECT virtual_warehouse_id FROM invoice_items WHERE invoice_id = $1', [order.id])).rows[0].virtual_warehouse_id, ooo.id);
    check('поставка на WB: склад выбирают из «Основного» и складов WB; заказы берут склад поставки');

    // ---- Сборка — только товар склада поставки ----
    await api('POST', `/api/shipping/assembly/${supply.id}/start`, worker, {}, 201);
    const itemId = order.items[0].id;
    const sug = await api('GET', `/api/shipping/suggest/${itemId}`, worker);
    assert.deepEqual(sug.cells.map((c) => c.available), [30]); assert.equal(sug.shortfall, 10);
    const tooMuch = await call('POST', '/api/shipping', worker, { invoiceItemId: itemId, pickedQty: 35, cellBlockId: cells[0], isFinal: false });
    assert.equal(tooMuch.status, 409); assert.match(tooMuch.body.error, /только 30 шт\. склада «ООО БББ»/);
    await api('POST', '/api/shipping', worker, { invoiceItemId: itemId, pickedQty: 30, cellBlockId: cells[0], isFinal: false }, 201);
    const other = await call('POST', '/api/shipping', worker, { invoiceItemId: itemId, pickedQty: 1, cellBlockId: cells[0], isFinal: false });
    assert.equal(other.status, 409); assert.match(other.body.error, /числится за другим складом продавца/);
    const list = await api('GET', `/api/shipping/pick-list?supplyId=${supply.id}`, worker);
    assert.equal(list.lines[0].shortfall, 10);
    assert.equal(list.lines[0].vwName, 'ООО БББ');
    check('сборка берёт только товар склада поставки; товар «Озона» в той же ячейке — отказ с объяснением');

    // ---- Перенос складом: сразу, продавцу уведомление ----
    const t1 = await api('POST', '/api/vwarehouses/transfers', owner, { companyId: company, sku: 'R-1', qty: 20, fromVw: null, toVw: ooo.id, note: 'под поставку' }, 201);
    assert.equal(t1.status, 'done');
    assert.deepEqual(await vwQty(), { 'Основной': 30, 'Озон': 100, 'ООО БББ': 20 });
    await api('POST', '/api/shipping', worker, { invoiceItemId: itemId, pickedQty: 10, cellBlockId: cells[0], isFinal: true }, 201);
    assert.ok((await api('GET', '/api/vwarehouses/notifications', seller)).some((n) => n.kind === 'vw_transfer_done' && /«Основной» → «ООО БББ»/.test(n.text)));
    await api('POST', '/api/vwarehouses/transfers', owner, { companyId: company, sku: 'R-1', qty: 31, fromVw: null, toVw: ozon.id }, 409);
    // То, что ждёт сборки со склада, не переносится.
    const order2 = await api('POST', '/api/invoices', owner, { companyId: company, number: 'WB-VW2', direction: 'out',
      items: [{ sku: 'R-1', name: 'Резинки чёрные', declaredQty: 25 }] }, 201);
    await db("UPDATE invoices SET source = 'wb', external_id = 'WB-VW2' WHERE id = $1", [order2.id]);
    await db("UPDATE invoice_items SET mp_rid = 'rid-' || id WHERE invoice_id = $1", [order2.id]);
    await api('POST', '/api/supplies', owner, { invoiceIds: [order2.id], marketplace: 'wb', virtualWarehouseId: null }, 201);
    await api('POST', '/api/vwarehouses/transfers', owner, { companyId: company, sku: 'R-1', qty: 6, fromVw: null, toVw: ozon.id }, 409);
    check('перенос складом — сразу, продавцу уведомление; нельзя больше, чем свободно на складе');

    // ---- Заявка продавца — складу «очень важно» ----
    const req1 = await api('POST', '/api/vwarehouses/transfers', seller, { sku: 'R-1', qty: 10, fromVw: ozon.id, toVw: opt.id, note: 'на опт' }, 201);
    assert.equal(req1.status, 'requested');
    const entry = (await db(`SELECT id, urgent, status FROM journal_entries WHERE entity_type = 'vw_transfer' AND entity_id = $1`, [req1.id])).rows[0];
    assert.deepEqual([entry.urgent, entry.status], [true, 'pending']);
    await api('POST', `/api/vwarehouses/transfers/${req1.id}/decide`, seller, { approve: true }, 403);
    await api('POST', `/api/journal/${entry.id}/resolve`, owner, { resolution: 'confirm' }, 201);
    assert.equal((await vwQty())['Опт'], 10);
    assert.ok((await api('GET', '/api/vwarehouses/notifications', seller)).some((n) => n.kind === 'vw_transfer_done' && /ПЕР-/.test(n.text)));
    const req2 = await api('POST', '/api/vwarehouses/transfers', seller, { sku: 'R-1', qty: 5, fromVw: ozon.id, toVw: opt.id }, 201);
    const rej = await api('POST', `/api/vwarehouses/transfers/${req2.id}/decide`, manager, { approve: false, reason: 'нет места' });
    assert.equal(rej.status, 'rejected');
    assert.ok((await api('GET', '/api/vwarehouses/notifications', seller)).some((n) => n.kind === 'vw_transfer_rejected' && /нет места/.test(n.text)));
    check('заявка продавца: «очень важно» в журнале; «Подтвердить» выполняет перенос, отказ — с причиной; продавцу уведомление');

    // ---- Права склада: продавец отключил переносы ----
    await api('PATCH', '/api/vwarehouses/rights', owner, { rights: { transfer: false } }, 403);
    assert.deepEqual((await api('PATCH', '/api/vwarehouses/rights', seller, { rights: { transfer: false } })).rights, { transfer: false, shortage: true });
    const asked = await api('POST', '/api/vwarehouses/transfers', owner, { companyId: company, sku: 'R-1', qty: 5, fromVw: ozon.id, toVw: null }, 201);
    assert.equal(asked.status, 'waiting_seller');
    await api('POST', `/api/vwarehouses/transfers/${asked.id}/decide`, owner, { approve: true }, 403);
    const before = await vwQty();
    await api('POST', `/api/vwarehouses/transfers/${asked.id}/decide`, seller, { approve: true });
    assert.equal((await vwQty())['Озон'], before['Озон'] - 5);
    await api('PATCH', '/api/vwarehouses/rights', seller, { rights: { transfer: true } });
    check('продавец отключил право — перенос склада ждёт его согласия; согласился — выполнено');

    // ---- Строки документа: склад до начала работы ----
    const manual = await api('POST', '/api/invoices', owner, { companyId: company, number: 'ПР-РУЧН',
      items: [{ sku: 'R-1', name: 'Резинки чёрные', declaredQty: 3, virtualWarehouseId: opt.id }] }, 201);
    assert.equal(manual.items[0].virtual_warehouse_id, opt.id);
    await api('POST', '/api/vwarehouses/items', owner, { itemIds: [manual.items[0].id], vw: ozon.id });
    await api('POST', '/api/vwarehouses/items', owner, { itemIds: [order2.items[0].id], vw: ozon.id }, 409);
    await api('POST', `/api/receiving/session/${manual.id}/start`, worker, {}, 201);
    await api('POST', '/api/receiving', worker, { invoiceItemId: manual.items[0].id, acceptedQty: 3, cellBlockId: cells[1] }, 201);
    await api('POST', '/api/vwarehouses/items', owner, { itemIds: [manual.items[0].id], vw: null }, 409);
    assert.equal((await db('SELECT virtual_warehouse_id FROM cell_stock WHERE cell_block_id = $1', [cells[1]])).rows[0].virtual_warehouse_id, ozon.id);
    check('склад у строки документа меняют до начала работы; заказ в поставке — нельзя; принятое — нельзя');

    // ---- Брак помнит склад ----
    const bad = await api('POST', '/api/defects/moves', worker, { companyId: company, sku: 'R-1', fromCellBlockId: cells[1], toCellBlockId: cells[3],
      qty: 1, bucket: 'defective', source: 'move', vw: ozon.id }, 201);
    assert.equal((await db('SELECT virtual_warehouse_id FROM defect_moves WHERE id = $1', [bad.id])).rows[0].virtual_warehouse_id, ozon.id);
    assert.equal((await db("SELECT virtual_warehouse_id FROM cell_stock WHERE cell_block_id = $1 AND quality = 'defective'", [cells[3]])).rows[0].virtual_warehouse_id, ozon.id);
    const dec = await api('POST', '/api/sellers/defects/decisions', seller, { sku: 'R-1', bucket: 'defective', qty: 1, action: 'repack' }, 201);
    await api('POST', `/api/defects/tasks/${dec.id}/done`, worker, { cellBlockId: cells[2] });
    assert.equal((await db("SELECT virtual_warehouse_id FROM cell_stock WHERE cell_block_id = $1 AND quality = 'good'", [cells[2]])).rows[0].virtual_warehouse_id, ozon.id);
    check('брак помнит склад; перепакованное возвращается на тот же склад');

    // ---- Пересчёт не стирает склад: недостача с «Основного», потом с большего ----
    const now = (await db(`SELECT COALESCE(w.name, 'Основной') AS name, SUM(cs.qty)::int AS n FROM cell_stock cs
      LEFT JOIN virtual_warehouses w ON w.id = cs.virtual_warehouse_id
      WHERE cs.cell_block_id = $1 AND cs.quality = 'good' GROUP BY 1 ORDER BY 1`, [cells[0]])).rows;
    const total = now.reduce((n, r) => n + r.n, 0);
    const main = now.find((r) => r.name === 'Основной').n;
    const taskId = await run(async (c) => {
      const r = await c.query('INSERT INTO inventory_runs(warehouse_id) VALUES($1) RETURNING id', [warehouseId]);
      return (await c.query(`INSERT INTO inventory_tasks(run_id,warehouse_id,cell_block_id,reason) VALUES($1,$2,$3,'тест') RETURNING id`,
        [r.rows[0].id, warehouseId, cells[0]])).rows[0].id;
    });
    const opened = await api('POST', `/api/inventory/tasks/${taskId}/open`, worker);
    await api('POST', `/api/inventory/tasks/${taskId}/count`, worker, {
      lines: [{ sku: 'R-1', companyId: company, quality: 'good', qty: total - main - 3 }], snapshotId: opened.snapshotId }, 200);
    await api('POST', `/api/inventory/tasks/${taskId}/resolve`, owner, { decision: 'apply' });
    const after = Object.fromEntries((await db(`SELECT COALESCE(w.name, 'Основной') AS name, SUM(cs.qty)::int AS n FROM cell_stock cs
      LEFT JOIN virtual_warehouses w ON w.id = cs.virtual_warehouse_id
      WHERE cs.cell_block_id = $1 AND cs.quality = 'good' GROUP BY 1`, [cells[0]])).rows.map((r) => [r.name, r.n]));
    const largest = now.filter((r) => r.name !== 'Основной').sort((a, b) => b.n - a.n)[0];
    assert.equal(after['Основной'], undefined);
    assert.equal(after[largest.name], largest.n - 3);
    assert.ok((await api('GET', '/api/vwarehouses/notifications', seller)).some((n) => n.kind === 'inventory_shortage'
      && n.text.includes(`«Основной» — ${main} шт.`) && n.text.includes(`«${largest.name}» — 3 шт.`)));
    check('пересчёт: недостача сначала с «Основного», потом с самого большого склада; продавцу уведомление');

    // ---- Убрать склад можно только пустой ----
    await api('DELETE', `/api/vwarehouses/${ozon.id}?companyId=${company}`, owner, undefined, 409);
    const t3 = await api('POST', '/api/vwarehouses/transfers', owner, { companyId: company, sku: 'R-1', qty: 10, fromVw: opt.id, toVw: null }, 201);
    assert.equal(t3.status, 'done');
    await api('DELETE', `/api/vwarehouses/${opt.id}?companyId=${company}`, owner);
    assert.ok(!(await api('GET', '/api/vwarehouses', seller)).warehouses.some((w) => w.id === opt.id));
    check('убрать склад можно только пустой');

    // ---- Продавец уведомления прочитал ----
    await api('POST', '/api/vwarehouses/notifications/seen', seller);
    assert.equal((await api('GET', '/api/vwarehouses/notifications', seller)).filter((n) => n.unseen).length, 0);
    check('уведомления продавцу: прочитал — больше не новые');

    console.log(`\n${passed} checks passed`);
  } finally {
    await new Promise((r) => server.close(r)); await pool.end();
  }
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
