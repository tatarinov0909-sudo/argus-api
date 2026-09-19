// Аргус меняет статусы на Wildberries: поставка площадки, подтверждение
// заказов, этикетки, QR и передача в доставку.
//
// Сети здесь нет: площадка подменяется заглушкой. Проверяется главное —
// без разрешения владельца не делается ни одного вызова, отвергнутый заказ
// уходит из местной поставки, а неудача на площадке не отменяет отгрузку,
// которая уже случилась в физическом мире.
const assert = require('node:assert/strict');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !/test/i.test(new URL(dbUrl).pathname) || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Select a separate test DATABASE_URL and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const credentials = require('../src/marketplaces/credentials');
const wbHandoff = require('../src/supplies/wbHandoff');
const service = require('../src/supplies/service');

let count = 0;
const check = (name, fn) => { fn(); count += 1; console.log('PASS ' + name); };

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const must = async (method, path, token, body, status = 200) => {
    const r = await api(method, path, token, body);
    assert.equal(r.status, status, `${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  try {
    const stamp = Date.now();
    const owner = await must('POST', '/api/auth/owner/register', null, {
      name: 'WB write owner', email: `wbwrite-${stamp}@test.local`,
      password: 'synthetic-pass-123', warehouseName: 'WB write test', city: 'Test',
    }, 201);
    const warehouseId = JSON.parse(Buffer.from(owner.token.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = await must('POST', '/api/sellers/companies', owner.token, { name: 'WB seller' }, 201);
    const staff = await must('POST', '/api/staff', owner.token, { name: 'Worker' }, 201);
    const worker = await must('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code });
    await must('POST', '/api/cells/rows', owner.token, { configs: [{ rackCount: 2, tierCount: 1 }] }, 201);
    const cell = (await must('GET', '/api/cells/rows', owner.token)).flatMap((r) => r.blocks)[0].id;
    await run((q) => q.query(
      `INSERT INTO products(warehouse_id,company_id,sku,name) VALUES($1,$2,'WW-1','Товар записи')`,
      [warehouseId, company.id],
    ));
    const receipt = await must('POST', '/api/invoices', owner.token, {
      companyId: company.id, number: 'WW-IN', items: [{ sku: 'WW-1', name: 'Товар записи', declaredQty: 30 }],
    }, 201);
    await must('POST', '/api/receiving', worker.token,
      { invoiceItemId: receipt.items[0].id, acceptedQty: 30, cellBlockId: cell }, 201);

    const order = async (externalId) => {
      const inv = await must('POST', '/api/invoices', owner.token, {
        companyId: company.id, number: 'WB-' + externalId, direction: 'out',
        items: [{ sku: 'WW-1', name: 'Товар записи', declaredQty: 1 }],
      }, 201);
      await run((q) => q.query(
        `UPDATE invoices SET source='wb', external_id=$2, mp_supplier_status='new' WHERE id=$1`,
        [inv.id, String(externalId)],
      ));
      await run((q) => q.query(`UPDATE invoice_items SET mp_rid=$2 WHERE invoice_id=$1`, [inv.id, 'rid-' + externalId]));
      return inv;
    };
    const good1 = await order(80001);
    const good2 = await order(80002);
    const refused = await order(80003);
    const beforePermission = await order(80004);

    // Ключ площадки есть, запись владельцем не разрешена.
    await run((c) => credentials.save(c, warehouseId, {
      companyId: company.id, marketplace: 'wb', token: 'synthetic-write-token',
    }));

    const calls = [];
    // Как у WB: пачка с одним чужим заказом не проходит целиком, по одному —
    // проходят все, кроме него; состав поставки WB отдаёт отдельным методом.
    const attached = new Set();
    const fakeWb = {
      createSupply: async (token, name) => { calls.push(['createSupply', name]); return 'WB-GI-777'; },
      addOrders: async (token, supply, ids) => {
        calls.push(['addOrders', supply, ids.map(String).join(',')]);
        if (ids.map(String).includes('80003')) throw new Error('Заказ уже в другой поставке');
        ids.forEach((id) => attached.add(String(id)));
        return true;
      },
      supplyOrderIds: async () => { calls.push(['supplyOrderIds']); return [...attached]; },
      supplyBarcode: async () => { calls.push(['supplyBarcode']); return { barcode: 'WB-BARCODE-777', file: 'c3ZnLWZha2U=', type: 'svg' }; },
      orderStickers: async (token, ids) => {
        calls.push(['orderStickers', ids.join(',')]);
        return ids.map((id) => ({ orderId: String(id), partA: '100', partB: '2000' + String(id).slice(-2), barcode: 'ST' + id, file: 'c3ZnLXN0aWNrZXI=' }));
      },
      setShipping: async (token, supply, p) => { calls.push(['setShipping', supply, String(p.pointId), p.date]); return true; },
      deliverSupply: async (token, supply) => { calls.push(['deliverSupply', supply]); return true; },
      deleteSupply: async (token, supply) => { calls.push(['deleteSupply', supply]); return true; },
    };
    const handOver = (supply, orders) => wbHandoff.handOver({
      warehouseId, companyId: company.id, supply, orders,
      withTx: (fn) => withTenantContext({ warehouseId }, fn), api: fakeWb,
    });

    // ---------- Запись выключена ----------
    const supplyA = await run((c) => service.create(c, warehouseId, { invoiceIds: [beforePermission.id], marketplace: 'wb', actor: { type: 'owner' } }));
    const off = await handOver(supplyA, supplyA.marketplaceOrders);
    check('без разрешения владельца Аргус не делает на площадке ничего', () => {
      assert.equal(off.skipped, 'write_disabled');
      assert.deepEqual(calls, []);
    });

    // ---------- Владелец разрешил запись ----------
    await must('PATCH', `/api/marketplaces/${company.id}/wb/write`, owner.token, { enabled: true });
    const stored = await run((c) => c.query('SELECT write_enabled FROM marketplace_credentials WHERE company_id=$1', [company.id]));
    check('разрешение записи сохраняется отдельным явным действием', () => {
      assert.equal(stored.rows[0].write_enabled, true);
    });
    const badBody = await api('PATCH', `/api/marketplaces/${company.id}/wb/write`, owner.token, { enabled: 'да' });
    check('разрешение нельзя включить невнятным значением', () => assert.equal(badBody.status, 400));

    // ---------- Дата отгрузки проверяется сразу ----------
    const pastDate = await run((c) => service.create(c, warehouseId, {
      invoiceIds: [good1.id], marketplace: 'wb', shipDate: '2020-01-01', shippingPointId: 100, actor: { type: 'owner' },
    }).then(() => null, (err) => err));
    check('прошедшую дату отгрузки поставка не принимает', () => {
      assert.equal(pastDate && pastDate.status, 400);
    });
    const badDate = await run((c) => service.create(c, warehouseId, {
      invoiceIds: [good1.id], marketplace: 'wb', shipDate: '2026-02-30', actor: { type: 'owner' },
    }).then(() => null, (err) => err));
    check('несуществующую дату — тоже', () => assert.equal(badDate && badDate.status, 400));

    // ---------- Поставка уходит на площадку ----------
    const planned = '2099-12-31';
    const supply = await run((c) => service.create(c, warehouseId, {
      invoiceIds: [good1.id, good2.id, refused.id], marketplace: 'wb',
      shipDate: planned, shippingPointId: 100, destination: 'Пункт стенда', actor: { type: 'owner' },
    }));
    assert.equal(supply.marketplaceOrders.length, 3, JSON.stringify(supply));
    const result = await handOver(supply, supply.marketplaceOrders);
    const state = await run((c) => c.query(
      `SELECT s.mp_supply_id, s.mp_handed_at, s.mp_barcode,
              (SELECT count(*) FROM invoices i WHERE i.supply_id=s.id) AS orders,
              (SELECT count(*) FROM invoices i WHERE i.supply_id=s.id AND i.mp_confirmed_at IS NOT NULL) AS confirmed,
              (SELECT count(*) FROM marketplace_order_stickers st WHERE st.company_id=$2) AS stickers
         FROM supplies s WHERE s.id=$1`, [supply.id, company.id]));
    check('поставка создана на площадке, заказы подтверждены, этикетки сохранены', () => {
      assert.equal(result.mpSupplyId, 'WB-GI-777');
      assert.equal(result.confirmed.length, 2);
      assert.equal(state.rows[0].mp_supply_id, 'WB-GI-777');
      assert.ok(state.rows[0].mp_handed_at);
      assert.equal(Number(state.rows[0].confirmed), 2);
      assert.equal(Number(state.rows[0].stickers), 2);
    });
    check('WB сразу получает пункт и плановую дату отгрузки, способ — везём сами', () => {
      assert.ok(calls.some((c) => c[0] === 'setShipping' && c[1] === 'WB-GI-777' && c[2] === '100' && c[3] === planned),
        JSON.stringify(calls));
      assert.equal(result.shippingError, null);
    });
    check('заказы уходят на WB пачкой, а не по одному', () => {
      const first = calls.find((c) => c[0] === 'addOrders');
      assert.equal(first[2].split(',').length, 3, JSON.stringify(calls));
    });
    check('QR поставки до передачи в доставку не запрашивается — WB его ещё не отдаёт', () => {
      assert.ok(!calls.some((c) => c[0] === 'supplyBarcode'), JSON.stringify(calls));
      assert.equal(state.rows[0].mp_barcode, null);
    });
    check('заказ, который площадка не приняла, ушёл из местной поставки', () => {
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0].externalId, '80003');
      assert.equal(Number(state.rows[0].orders), 2, 'отвергнутый заказ остался в поставке');
    });
    const pending = await run((c) => c.query(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE warehouse_id=$1 AND invoice_id=$2 AND status='pending'`, [warehouseId, refused.id]));
    check('и по нему осталась задача человеку, а не тишина', () => {
      assert.equal(pending.rows[0].n, 1);
    });
    const contents = await must('GET', `/api/supplies/${supply.id}`, owner.token);
    check('в составе поставки для печати есть этикетки заказов', () => {
      assert.equal(contents.supply.mpSupplyId, 'WB-GI-777');
      assert.equal(contents.stickers.length, 2, JSON.stringify(contents.stickers));
      assert.ok(contents.stickers[0].partA && contents.stickers[0].barcode);
    });

    // ---------- Отгрузка передаёт поставку в доставку ----------
    for (const inv of [good1, good2]) {
      const full = await must('GET', `/api/invoices/${inv.id}`, owner.token);
      await must('POST', '/api/shipping', worker.token,
        { invoiceItemId: full.items[0].id, pickedQty: 1, cellBlockId: cell }, 201);
    }
    const shipped = await must('POST', `/api/supplies/${supply.id}/ship`, owner.token, { destination: 'СЦ' });
    check('отгрузка поставки доходит до площадки', () => {
      // Настоящий маршрут ходит в живой WB, поэтому здесь он не вызывается:
      // проверяем отдельно тем же кодом с заглушкой ниже.
      assert.equal(shipped.status, 'shipped');
    });
    const shippedRow = (await run((c) => c.query(
      `SELECT id, number, mp_supply_id, mp_shipping_point_id, mp_shipping_set_at FROM supplies WHERE id=$1`,
      [supply.id]))).rows[0];
    check('поставка помнит пункт, дату и что WB их принял', () => {
      assert.equal(String(shippedRow.mp_shipping_point_id), '100');
      assert.ok(shippedRow.mp_shipping_set_at);
      assert.equal(shipped.ship_date, planned);
    });

    // Без пункта WB ответит 409 — Аргус и не пробует, а говорит человеку.
    const before = calls.length;
    const noPoint = await wbHandoff.deliver({
      warehouseId, companyId: company.id, api: fakeWb,
      supply: { ...shippedRow, mp_shipping_point_id: null },
      withTx: (fn) => withTenantContext({ warehouseId }, fn),
    });
    check('без пункта отгрузки в доставку не передаём, а оставляем задачу человеку', () => {
      assert.ok(noPoint.error && /пункт/.test(noPoint.error), JSON.stringify(noPoint));
      assert.equal(calls.length, before, 'был вызов WB');
    });

    const delivered = await wbHandoff.deliver({
      warehouseId, companyId: company.id, api: fakeWb, supply: shippedRow,
      withTx: (fn) => withTenantContext({ warehouseId }, fn),
    });
    check('перед передачей в доставку дата отгрузки — сегодняшняя, и только потом deliver', () => {
      const after = calls.slice(before);
      const set = after.findIndex((c) => c[0] === 'setShipping');
      const dlv = after.findIndex((c) => c[0] === 'deliverSupply');
      assert.ok(set >= 0 && dlv > set, JSON.stringify(after));
      assert.equal(after[set][3], service.moscowToday());
    });
    const afterDeliver = await run((c) => c.query('SELECT mp_delivered_at, mp_barcode FROM supplies WHERE id=$1', [supply.id]));
    check('поставка отмечена переданной в доставку, и теперь у неё есть QR для ворот', () => {
      assert.equal(delivered.delivered, true);
      assert.ok(afterDeliver.rows[0].mp_delivered_at);
      assert.ok(calls.some((c) => c[0] === 'deliverSupply' && c[1] === 'WB-GI-777'));
      assert.equal(afterDeliver.rows[0].mp_barcode, 'WB-BARCODE-777');
    });

    // ---------- Площадка не ответила ----------
    const broken = { ...fakeWb, deliverSupply: async () => { throw new Error('WB ответил с ошибкой 500'); } };
    const failed = await wbHandoff.deliver({
      warehouseId, companyId: company.id, api: broken, supply: shippedRow,
      withTx: (fn) => withTenantContext({ warehouseId }, fn),
    });
    const complaint = await run((c) => c.query(
      `SELECT action_text FROM journal_entries WHERE warehouse_id=$1 AND status='pending'
        AND action_text LIKE '%не удалось передать в доставку%' ORDER BY created_at DESC LIMIT 1`, [warehouseId]));
    check('неудача на площадке не отменяет отгрузку, но оставляет задачу человеку', () => {
      assert.ok(failed.error, JSON.stringify(failed));
      assert.ok(complaint.rows[0], 'нет записи в журнале о несданной поставке');
    });

    // ---------- Отвергнутые заказы не подтверждались ----------
    const notConfirmed = await run((c) => c.query(
      'SELECT mp_confirmed_at, supply_id FROM invoices WHERE id=$1', [refused.id]));
    check('непринятый заказ не помечен подтверждённым на площадке', () => {
      assert.equal(notConfirmed.rows[0].mp_confirmed_at, null);
      assert.equal(notConfirmed.rows[0].supply_id, null);
    });

    console.log(`\n${count} WB write checks passed`);
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
