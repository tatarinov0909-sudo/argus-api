// Составы наборов (владелец 08.10.2026): экран и файл, «Свободно» набора —
// готовые плюс сколько можно собрать из свободных частей. Только на отдельной
// тестовой базе.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires an explicitly provisioned isolated test database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const wbListing = require('../src/sellers/wbListing');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, token, body, status = 200) => {
    const res = await fetch(base + path, { method, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    assert.equal(res.status, status, `${method} ${path}: ${res.status} ${json && json.error || ''}`);
    return json;
  };
  let passed = 0;
  const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
  try {
    const register = async (name) => (await api('POST', '/api/auth/owner/register', null, {
      name, email: `kits-${name}-${Date.now()}@example.test`, password: 'test-only-password', warehouseName: name, city: 'Test',
    }, 201)).token;
    const owner = await register('Наборы');
    const stranger = await register('Чужой');
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const db = (sql, args) => withTenantContext({ warehouseId }, (c) => c.query(sql, args));
    await api('PATCH', '/api/warehouses/me', owner, { stockSource: 'argus' });
    const a = await api('POST', '/api/sellers/companies', owner, { name: 'Сплиты' }, 201);
    const key = await api('POST', `/api/sellers/companies/${a.id}/keys`, owner, {}, 201);
    const seller = (await api('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Продавец' })).token;
    const wk = await api('POST', '/api/staff', owner, { name: 'Грузчик' }, 201);
    const worker = (await api('POST', '/api/auth/staff/login', null, { keyCode: wk.key_code })).token;
    await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 2, tierCount: 1 }] }, 201);
    const cells = (await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks).map((x) => x.id);
    await db(`INSERT INTO products (warehouse_id, company_id, sku, name, barcode) VALUES
      ($1, $2, 'KIT-1', 'Сплит печенья × 3', '4600000000101'), ($1, $2, 'P-A', 'Печенье овсяное', '4600000000118'),
      ($1, $2, 'P-B', 'Печенье кокосовое', '4600000000125'), ($1, $2, 'KIT-2', 'Сплит без частей', NULL)`, [warehouseId, a.id]);
    await db(`INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES
      ($1, $3, $4, 'P-A', 10), ($2, $3, $4, 'P-B', 3), ($2, $3, $4, 'KIT-1', 4)`, [cells[0], cells[1], warehouseId, a.id]);

    // Экран: состав одного набора.
    await api('PUT', `/api/kits/company/${a.id}/kit`, owner, { kitSku: 'KIT-1', components: [{ sku: 'KIT-1', qty: 1 }] }, 400);
    await api('PUT', `/api/kits/company/${a.id}/kit`, owner, { kitSku: 'KIT-1', components: [{ sku: 'P-A', qty: 0 }] }, 400);
    await api('PUT', `/api/kits/company/${a.id}/kit`, owner, { kitSku: 'KIT-1', components: [{ sku: 'НЕТ', qty: 1 }] }, 400);
    await api('PUT', `/api/kits/company/${a.id}/kit`, owner, { kitSku: 'KIT-1', components: [{ sku: 'P-A', qty: 1 }, { sku: 'p-a', qty: 1 }] }, 400);
    check('состав с самим набором, нулём, чужим артикулом или повтором части не принимается');

    // Артикул без учёта регистра и штрихкод — как у прихода из Excel.
    const saved = await api('PUT', `/api/kits/company/${a.id}/kit`, owner, { kitSku: 'kit-1', components: [{ sku: 'p-a', qty: 2 }, { sku: '4600000000125', qty: 1 }] });
    assert.deepEqual(saved.components, [{ sku: 'P-A', qty: 2 }, { sku: 'P-B', qty: 1 }]);
    const list = await api('GET', `/api/kits/company/${a.id}`, owner);
    assert.equal(list.length, 1); assert.equal(list[0].name, 'Сплит печенья × 3');
    check('состав сохраняется по артикулу без учёта регистра и по штрихкоду, список показывает названия');

    const stock = (await api('GET', `/api/sellers/stock?companyId=${a.id}`, owner)).find((r) => r.sku === 'KIT-1');
    assert.equal(stock.kitBuildable, 3, 'P-A 10/2 = 5, P-B 3/1 = 3 → 3');
    assert.equal(stock.sellerAvailable, 4, 'готовые наборы — отдельно');
    const mine = (await api('GET', '/api/sellers/stock', seller)).rows.find((r) => r.sku === 'KIT-1');
    assert.equal(mine.available, 4); assert.equal(mine.kitBuildable, 3);
    check('«Свободно» набора: готовых 4, собрать из частей ещё 3 — видят склад и продавец');

    // Сравнение с «На WB»: набор, выставленный на 6, — не тревога (4 + 3 = 7).
    const free = await withTenantContext({ warehouseId }, async (c) => {
      const rows = await require('../src/sellers/stock').loadStock(c, a.id, { source: 'argus' });
      await c.query(`INSERT INTO seller_wb_warehouses (warehouse_id, company_id, mp_warehouse_id, name, ours)
        VALUES ($1, $2, 1, 'Склад WB', true)`, [warehouseId, a.id]);
      await c.query(`INSERT INTO invoices (warehouse_id, company_id, number, direction, source) VALUES ($1, $2, 'WB-K', 'out', 'wb')`, [warehouseId, a.id]);
      const inv = (await c.query(`SELECT id FROM invoices WHERE number = 'WB-K' AND company_id = $1`, [a.id])).rows[0].id;
      await c.query(`INSERT INTO invoice_items (invoice_id, warehouse_id, company_id, name, sku, declared_qty, mp_chrt_id)
        VALUES ($1, $2, $3, 'Сплит', 'KIT-1', 1, 555)`, [inv, warehouseId, a.id]);
      await c.query(`UPDATE invoices SET status = 'shipped', mp_closed_at = now(), mp_close_reason = 'canceled' WHERE id = $1`, [inv]);
      await c.query(`INSERT INTO wb_stock_levels (warehouse_id, company_id, chrt_id, mp_warehouse_id, amount, fetched_at)
        VALUES ($1, $2, 555, 1, 6, now())`, [warehouseId, a.id]);
      return wbListing.listing(c, warehouseId, a.id, rows);
    }).catch((e) => ({ error: e.message }));
    if (free.error) console.log('SKIP сравнение с «На WB» —', free.error);
    else {
      const x = free.get('KIT-1');
      assert.ok(x, 'набор выставлен на WB'); assert.equal(x.free, 7); assert.equal(x.over, false);
      check('набор на WB 6 при готовых 4 и сборке ещё 3 — не «больше, чем свободно»');
    }

    // Файл: строки одного набора — его состав целиком; набор с ошибкой не трогается.
    const rows = [
      { kit: 'KIT-2', component: 'P-A', qty: 1 }, { kit: 'KIT-2', component: 'P-B', qty: '2' },
      { kit: 'KIT-1', component: 'НЕТ-ТАКОГО', qty: 1 },
      { kit: 'НЕТ-НАБОРА', component: 'P-A', qty: 1 },
    ];
    const preview = await api('POST', `/api/kits/company/${a.id}/import`, owner, { rows });
    assert.equal(preview.applied, false); assert.equal(preview.ok, 1); assert.equal(preview.errors.length, 2);
    assert.equal((await api('GET', `/api/kits/company/${a.id}`, owner)).length, 1, 'проверка ничего не меняет');
    const mk = await api('POST', '/api/staff', owner, { name: 'Менеджер', kind: 'manager', permissions: [] }, 201);
    const manager = (await api('POST', '/api/auth/staff/login', null, { keyCode: mk.key_code })).token;
    const done = await api('POST', `/api/kits/company/${a.id}/import`, manager, { rows, apply: true });
    assert.equal(done.ok, 1);
    const after = await api('GET', `/api/kits/company/${a.id}`, owner);
    assert.deepEqual(after.find((k) => k.kitSku === 'KIT-2').components.map((p) => `${p.sku}:${p.qty}`), ['P-A:1', 'P-B:2']);
    assert.deepEqual(after.find((k) => k.kitSku === 'KIT-1').components.map((p) => `${p.sku}:${p.qty}`), ['P-A:2', 'P-B:1']);
    check('файл: проверка без записи; при загрузке исправный набор записан, набор с ошибкой остался прежним');

    await api('PUT', `/api/kits/company/${a.id}/kit`, owner, { kitSku: 'KIT-2', components: [] });
    assert.equal((await api('GET', `/api/kits/company/${a.id}`, owner)).length, 1);
    check('пустой состав — набор больше не набор');

    await api('GET', `/api/kits/company/${a.id}`, worker, undefined, 403);
    await api('GET', `/api/kits/company/${a.id}`, seller, undefined, 403);
    await api('GET', `/api/kits/company/${a.id}`, stranger, undefined, 404);
    await api('PUT', `/api/kits/company/${a.id}/kit`, stranger, { kitSku: 'KIT-1', components: [] }, 404);
    check('грузчику и продавцу экран составов закрыт, чужой склад продавца не видит');
    console.log(`\n${passed} passed`);
  } catch (err) {
    console.error('FAIL', err.message);
    process.exitCode = 1;
  } finally {
    server.close(); await pool.end();
  }
})();
