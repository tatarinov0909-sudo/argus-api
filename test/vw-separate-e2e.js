// Склады продавца, этап 3 (владелец 02.10.2026): «хранить отдельно», зона
// склада, задания «переложить», предупреждения о заполненной зоне,
// напоминания Кладовщика, склад в начальных остатках и в возвратах.
// Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const { blockLabelSql } = require('../src/cells/label');
const kladovshchik = require('../src/agents/kladovshchik');

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
      name: 'Отдельно', email: `vws-${Date.now()}@example.test`, password: 'test-only-password', warehouseName: 'Отдельно', city: 'Test',
    }, 201)).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const db = (sql, args) => run((c) => c.query(sql, args));
    await db("UPDATE warehouses SET stock_source = 'argus' WHERE id = $1", [warehouseId]);
    const company = (await api('POST', '/api/sellers/companies', owner, { name: 'Резинки' }, 201)).id;
    await api('POST', '/api/products', owner, { sku: 'R-1', name: 'Резинки чёрные', companyId: company }, 201);
    const key = await api('POST', `/api/sellers/companies/${company}/keys`, owner, {}, 201);
    const seller = (await api('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Продавец' })).token;
    await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 6, tierCount: 1 }] }, 201);
    const cells = (await db(`SELECT cb.id, ${blockLabelSql('cb', 'wr')} AS label FROM cell_blocks cb
      JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id WHERE cb.warehouse_id = $1 ORDER BY wr.row_num, cb.rack_start`, [warehouseId])).rows;
    const [A, B, C, D, E, F] = cells;
    const wk = await api('POST', '/api/staff', owner, { name: 'Комплектовщик' }, 201);
    const worker = (await api('POST', '/api/auth/staff/login', null, { keyCode: wk.key_code })).token;
    const ozon = await api('POST', '/api/vwarehouses', owner, { companyId: company, name: 'Озон', marketplace: 'ozon' }, 201);
    const qty = async (quality = 'good') => Object.fromEntries((await db(
      `SELECT COALESCE(w.name, 'Остальной товар') AS name, SUM(cs.qty)::int AS n FROM cell_stock cs
         LEFT JOIN virtual_warehouses w ON w.id = cs.virtual_warehouse_id
        WHERE cs.company_id = $1 AND cs.quality::text = $2 AND cs.qty > 0 GROUP BY 1`, [company, quality])).rows.map((r) => [r.name, r.n]));
    const inCell = async (cell) => Object.fromEntries((await db(
      `SELECT COALESCE(w.name, 'Остальной товар') AS name, SUM(cs.qty)::int AS n FROM cell_stock cs
         LEFT JOIN virtual_warehouses w ON w.id = cs.virtual_warehouse_id
        WHERE cs.cell_block_id = $1 AND cs.qty > 0 GROUP BY 1`, [cell.id])).rows.map((r) => [r.name, r.n]));
    // Приход вручную: строки на склады, приёмка в указанные ячейки.
    let docNo = 0;
    const receive = async (lines) => {
      docNo += 1;
      const inv = await api('POST', '/api/invoices', owner, { companyId: company, number: `ПР-${docNo}`,
        items: lines.map((l) => ({ sku: 'R-1', name: 'Резинки чёрные', declaredQty: l.qty, virtualWarehouseId: l.vw })) }, 201);
      await api('POST', `/api/receiving/session/${inv.id}/start`, worker, {}, 201);
      const out = [];
      for (const [k, it] of inv.items.entries()) {
        out.push(await call('POST', '/api/receiving', worker, { invoiceItemId: it.id, acceptedQty: lines[k].qty, cellBlockId: lines[k].cell.id }));
      }
      return out;
    };

    // ---- Включили «хранить отдельно», а товар уже лежит вместе ----
    const r1 = await receive([{ qty: 100, vw: null, cell: A }, { qty: 50, vw: ozon.id, cell: A }]);
    assert.deepEqual(r1.map((r) => r.status), [201, 201]);
    const mixed = await api('GET', `/api/vwarehouses/${ozon.id}/mixed?companyId=${company}`, owner);
    assert.deepEqual(mixed, { cells: 1, units: 50 });
    const ask = await call('PATCH', `/api/vwarehouses/${ozon.id}`, owner, { companyId: company, keepSeparate: true });
    assert.equal(ask.status, 409); assert.match(ask.body.error, /выберите: задания комплектовщику на разделение или разделять только новый товар/);
    const on = await api('PATCH', `/api/vwarehouses/${ozon.id}`, owner, { companyId: company, keepSeparate: true, separateExisting: 'tasks' });
    assert.equal(on.keepSeparate, true); assert.equal(on.tasks, 1);
    let tasks = await api('GET', '/api/vwarehouses/move-tasks', worker);
    assert.equal(tasks.length, 1); assert.equal(tasks[0].left, 50); assert.equal(tasks[0].fromLabel, A.label);
    assert.ok(tasks[0].suggest.length && tasks[0].suggest.every((o) => o.blockId !== A.id));
    await api('POST', `/api/vwarehouses/move-tasks/${tasks[0].id}/step`, worker, { toCellBlockId: A.id, qty: 10 }, 400);
    await api('POST', `/api/vwarehouses/move-tasks/${tasks[0].id}/step`, worker, { toCellBlockId: B.id, qty: 20 });
    assert.deepEqual(await inCell(A), { 'Остальной товар': 100, 'Озон': 30 });
    const last = await api('POST', `/api/vwarehouses/move-tasks/${tasks[0].id}/step`, worker, { toCellBlockId: B.id, qty: 30 });
    assert.equal(last.status, 'done');
    assert.deepEqual(await inCell(B), { 'Озон': 50 });
    check('включили «хранить отдельно» при смешанном товаре — спросили; задание «переложить» делится шагами');

    // ---- Отдельно: не смешивать ----
    const bad = await receive([{ qty: 5, vw: null, cell: B }]);
    assert.equal(bad[0].status, 409); assert.match(bad[0].body.error, /Сюда нельзя: здесь лежит товар склада «Озон» — он хранится отдельно/);
    await api('POST', '/api/receiving', worker, { invoiceItemId: (await db(
      `SELECT ii.id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.number = 'ПР-2'`)).rows[0].id,
      acceptedQty: 5, cellBlockId: C.id }, 201);
    const moveBad = await call('POST', '/api/cells/move', worker, { sku: 'R-1', companyId: company, fromCellBlockId: A.id, toCellBlockId: B.id, qty: 1 });
    assert.equal(moveBad.status, 409);
    check('товар «Остального товара» нельзя положить к отдельному «Озону» — ни приёмкой, ни перемещением');

    // ---- Зона ----
    const zoned = await api('PATCH', `/api/vwarehouses/${ozon.id}`, owner, { companyId: company, zone: { cells: [D.label] } });
    assert.equal(zoned.zone.cells, 1); assert.equal(zoned.zone.text, D.label);
    const sug = await api('GET', `/api/agents/kladovshchik/suggest-cell?sku=R-1&companyId=${company}&vw=${ozon.id}`, worker);
    assert.deepEqual(sug.options.map((o) => [o.blockId, o.reason]), [[B.id, 'same_sku'], [D.id, 'vw_zone']].slice(0, sug.options.length));
    const outside = await receive([{ qty: 7, vw: ozon.id, cell: E }]);
    assert.equal(outside[0].status, 409); assert.match(outside[0].body.error, new RegExp(`своя зона, и в ней свободна ячейка ${D.label.replace(/\./g, '\\.')}`));
    await api('POST', '/api/receiving', worker, { invoiceItemId: (await db(
      `SELECT ii.id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.number = 'ПР-3'`)).rows[0].id,
      acceptedQty: 7, cellBlockId: D.id }, 201);
    const notMine = await receive([{ qty: 1, vw: null, cell: D }]);
    assert.equal(notMine[0].status, 409); assert.match(notMine[0].body.error, /закреплена за складом «Озон»/);
    // Зона заполнена — кладут рядом, руководителю запись.
    const full = await receive([{ qty: 3, vw: ozon.id, cell: E }]);
    assert.equal(full[0].status, 201);
    assert.ok((await db(`SELECT 1 FROM journal_entries WHERE warehouse_id = $1 AND entity_type = 'vw_zone'
      AND action_text LIKE '%вне его зоны%'`, [warehouseId])).rows.length);
    check('зона: пока в ней пусто — только туда; чужое туда нельзя; заполнена — рядом, руководителю запись');

    // ---- Перенос на отдельный склад — задание, переложенное сразу переходит ----
    const before = await qty();
    const t = await api('POST', '/api/vwarehouses/transfers', owner, { companyId: company, sku: 'R-1', qty: 10, fromVw: null, toVw: ozon.id }, 201);
    assert.equal(t.status, 'to_move');
    assert.deepEqual(await qty(), before);
    tasks = (await api('GET', '/api/vwarehouses/move-tasks', worker)).filter((x) => x.transfer === t.number);
    assert.equal(tasks.reduce((n, x) => n + x.left, 0), 10);
    await api('POST', `/api/vwarehouses/move-tasks/${tasks[0].id}/step`, worker, { toCellBlockId: E.id, qty: 4 });
    const mid = await qty();
    assert.equal(mid['Озон'], before['Озон'] + 4); assert.equal(mid['Остальной товар'], before['Остальной товар'] - 4);
    for (const x of tasks) {
      const left = (await api('GET', '/api/vwarehouses/move-tasks', worker)).find((y) => y.id === x.id);
      if (left) await api('POST', `/api/vwarehouses/move-tasks/${x.id}/step`, worker, { toCellBlockId: E.id, qty: left.left });
    }
    assert.equal((await db('SELECT status FROM vw_transfers WHERE id = $1', [t.id])).rows[0].status, 'done');
    assert.ok((await api('GET', '/api/vwarehouses/notifications', seller)).some((n) => n.kind === 'vw_moved' && n.text.includes(t.number)));
    check('перенос на склад «хранить отдельно» — задания комплектовщику; каждая переложенная штука сразу на новом складе');

    // ---- Предупреждение: везут на склад с заполненной зоной ----
    const inb = await api('POST', '/api/sellers/inbound', seller, { grid: [['Артикул', 'Количество', 'Склад'], ['R-1', 40, 'Озон']], apply: true });
    let warn = (await db(`SELECT id, status FROM journal_entries WHERE warehouse_id = $1 AND entity_type = 'vw_zone' AND invoice_id = $2`,
      [warehouseId, inb.invoice.id])).rows;
    assert.equal(warn.length, 1); assert.equal(warn[0].status, 'pending');
    await api('POST', `/api/journal/${warn[0].id}/resolve`, owner, { resolution: 'confirm' }, 400);
    await api('POST', `/api/journal/${warn[0].id}/resolve`, owner, { resolution: 'ack' }, 201);
    await api('POST', `/api/inbound/${inb.invoice.id}/arrived`, owner, {});
    warn = (await db(`SELECT action_text FROM journal_entries WHERE warehouse_id = $1 AND entity_type = 'vw_zone' AND invoice_id = $2
      ORDER BY created_at`, [warehouseId, inb.invoice.id])).rows;
    assert.equal(warn.length, 2); assert.match(warn[1].action_text, /^Машина приехала/);
    check('привоз на склад с заполненной зоной — предупреждение при оформлении и при приезде машины, «Принял к сведению»');

    // ---- Кладовщик напоминает; руководитель может выключить ----
    let now = await run((c) => kladovshchik.workNow(c, warehouseId));
    assert.ok(now.sellerWarehouses && now.sellerWarehouses.fullZones.some((z) => z.warehouse === 'Озон' && z.incoming === 40));
    const stockAns = await run((c) => kladovshchik.runTool(c, warehouseId, 'seller_stock', { seller: 'Резинки' }));
    assert.ok(stockAns.warehouses.some((w) => w.warehouse === 'Озон' && w.onHand > 0));
    await api('PATCH', '/api/warehouses/me', owner, { vwReminders: false });
    now = await run((c) => kladovshchik.workNow(c, warehouseId));
    assert.equal(now.sellerWarehouses, undefined);
    await api('PATCH', '/api/warehouses/me', owner, { vwReminders: true });
    check('Кладовщик: остатки по складам продавца, напоминания о зонах; выключаются в настройках');

    // ---- Начальные остатки: склад по умолчанию и столбец «Склад» ----
    const plan = await api('POST', '/api/cells/initial-stock', owner, { companyId: company, defaultVw: ozon.id,
      rows: [{ line: 2, cell: F.label, sku: 'R-1', qty: 4 }, { line: 3, cell: F.label, sku: 'R-1', qty: 6, warehouse: 'Остальной товар' },
        { line: 4, cell: F.label, sku: 'R-1', qty: 1, warehouse: 'Луна' }] });
    assert.deepEqual(plan.lines.map((l) => l.vwName || l.error.slice(0, 15)), ['Озон', 'Остальной товар', 'склада «Луна» у']);
    const applied = await api('POST', '/api/cells/initial-stock', owner, { companyId: company, defaultVw: ozon.id, apply: true,
      rows: [{ line: 2, cell: F.label, sku: 'R-1', qty: 4 }] });
    assert.equal(applied.applied, true);
    assert.equal((await inCell(F))['Озон'], 4);
    check('начальные остатки: склад по умолчанию и столбец «Склад»; неизвестный склад — ошибка строки');

    // ---- Возврат: склад выбирает склад; продавец запретил — нельзя ----
    const ret = await api('POST', '/api/returns/manual', worker, { companyId: company, items: [{ sku: 'R-1', qty: 2 }], vw: ozon.id }, 201);
    assert.equal((await db('SELECT virtual_warehouse_id FROM invoice_items WHERE invoice_id = $1', [ret.id])).rows[0].virtual_warehouse_id, ozon.id);
    // Продавцу о возврате не пишем (владелец 06.10.2026).
    assert.ok(!(await api('GET', '/api/vwarehouses/notifications', seller)).some((n) => n.text.includes(ret.number)));
    await api('PATCH', '/api/vwarehouses/rights', seller, { rights: { decide: false } });
    const denied = await call('POST', '/api/returns/manual', worker, { companyId: company, items: [{ sku: 'R-1', qty: 1 }], vw: ozon.id });
    assert.equal(denied.status, 409); assert.match(denied.body.error, /ляжет на «Остальной товар»/);
    await api('POST', '/api/returns/manual', worker, { companyId: company, items: [{ sku: 'R-1', qty: 1 }] }, 201);
    await api('PATCH', '/api/vwarehouses/rights', seller, { rights: { decide: true } });
    check('возврат: склад продавца выбирает склад (продавцу «обратите внимание»); продавец запретил — только «Остальной товар»');

    console.log(`\n${passed} checks passed`);
  } finally {
    await new Promise((r) => server.close(r)); await pool.end();
  }
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
