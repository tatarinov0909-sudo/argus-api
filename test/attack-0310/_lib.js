// Общие заготовки для независимой проверки 03.10.2026 (склад брака и склады
// продавца). Только синтетические данные и только одноразовая тестовая база
// argus_seller_test_*; база создаётся снаружи (stand/runt.sh).
//
// Код выхода: 1 — найдена ошибка (тест падает на нынешнем коде), 2 — сломался
// сам тест.
process.env.MARKETPLACE_KEY_SECRET = process.env.MARKETPLACE_KEY_SECRET || 'test-secret-for-local-only-000000';

const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Нужна отдельная тестовая база argus_seller_test_*');

const { createApp } = require('../../src/app');
const { pool, withTenantContext } = require('../../src/db/pool');
const { blockLabelSql } = require('../../src/cells/label');

const realFetch = global.fetch;

async function startApp() {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Наружу из теста — никуда (WB и прочее).
  global.fetch = async (input) => { throw new Error(`сеть в тесте закрыта: ${input}`); };
  async function api(method, path, token, body) {
    const res = await realFetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json };
  }
  async function ok(method, path, token, body, status) {
    const r = await api(method, path, token, body);
    const good = status !== undefined ? r.status === status : r.status < 300;
    if (!good) throw Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  const stop = async () => { global.fetch = realFetch; await new Promise((r) => server.close(r)); await pool.end(); };
  return { api, ok, stop, base };
}

const whIdOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')).warehouseId;
let uniq = 0;

// Склад (учёт по ячейкам Аргуса — числа без 1С), продавец с товарами,
// ряд ячеек, грузчик, менеджер, вход продавца.
async function stand({ ok, api }, { skus = [['R-1', 'Резинки чёрные']], racks = 8, tiers = 1, source = 'argus', managerGrants = [] } = {}) {
  uniq += 1;
  const reg = await ok('POST', '/api/auth/owner/register', null, {
    name: 'Проверка', email: `a0310-${Date.now()}-${uniq}@example.test`, password: 'test-only-password',
    warehouseName: `Проверка ${uniq}`, city: 'Москва',
  });
  const owner = reg.token;
  const warehouseId = whIdOf(owner);
  const run = (fn) => withTenantContext({ warehouseId }, fn);
  const q = async (sql, params = []) => (await run((c) => c.query(sql, params))).rows;
  await q('UPDATE warehouses SET stock_source = $2 WHERE id = $1', [warehouseId, source]);
  const company = (await ok('POST', '/api/sellers/companies', owner, { name: 'Резинки' })).id;
  for (const [sku, name] of skus) await ok('POST', '/api/products', owner, { sku, name, companyId: company });
  const key = await ok('POST', `/api/sellers/companies/${company}/keys`, owner, {});
  const seller = (await ok('POST', '/api/auth/seller/login', null, { keyCode: key.key_code, name: 'Продавец' })).token;
  await ok('POST', '/api/cells/rows', owner, { configs: [{ rackCount: racks, tierCount: tiers }] });
  const cells = (await q(`SELECT cb.id, ${blockLabelSql('cb', 'wr')} AS label FROM cell_blocks cb
      JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id WHERE cb.warehouse_id = $1
     ORDER BY wr.row_num, cb.rack_start, cb.tier_start`, [warehouseId]));
  const wk = await ok('POST', '/api/staff', owner, { name: 'Грузчик' });
  const worker = (await ok('POST', '/api/auth/staff/login', null, { keyCode: wk.key_code })).token;
  const mk = await ok('POST', '/api/staff', owner, { name: 'Оля', kind: 'manager', permissions: managerGrants });
  const manager = (await ok('POST', '/api/auth/staff/login', null, { keyCode: mk.key_code })).token;

  // Сколько товара продавца на каждом складе (по названию склада).
  const vwQty = async (quality = 'good', sku = null) => Object.fromEntries((await q(
    `SELECT COALESCE(w.name, 'Остальной товар') AS name, SUM(cs.qty)::int AS n FROM cell_stock cs
       LEFT JOIN virtual_warehouses w ON w.id = cs.virtual_warehouse_id
      WHERE cs.company_id = $1 AND cs.quality::text = $2 AND cs.qty > 0 AND ($3::text IS NULL OR cs.sku = $3)
      GROUP BY 1`, [company, quality, sku])).map((r) => [r.name, r.n]));
  const inCell = async (cell, quality = null) => Object.fromEntries((await q(
    `SELECT COALESCE(w.name, 'Остальной товар') AS name, SUM(cs.qty)::int AS n FROM cell_stock cs
       LEFT JOIN virtual_warehouses w ON w.id = cs.virtual_warehouse_id
      WHERE cs.cell_block_id = $1 AND cs.qty > 0 AND ($2::text IS NULL OR cs.quality::text = $2) GROUP BY 1`,
    [cell.id, quality])).map((r) => [r.name, r.n]));

  // Приход вручную: строки на склады продавца и приёмка в указанные ячейки.
  let docNo = 0;
  const receive = async (lines, { sku = skus[0][0], name = skus[0][1] } = {}) => {
    docNo += 1;
    const inv = await ok('POST', '/api/invoices', owner, { companyId: company, number: `ПР-А${docNo}`,
      items: lines.map((l) => ({ sku: l.sku || sku, name: l.name || name, declaredQty: l.declared || l.qty, virtualWarehouseId: l.vw ?? null })) });
    await ok('POST', `/api/receiving/session/${inv.id}/start`, worker, {});
    const out = [];
    for (const [k, it] of inv.items.entries()) {
      const l = lines[k];
      out.push(await api('POST', '/api/receiving', worker,
        { invoiceItemId: it.id, acceptedQty: l.qty, ...(l.qty > 0 && l.cell ? { cellBlockId: l.cell.id } : {}), ...(l.defect ? { defect: l.defect } : {}) }));
    }
    return { inv, results: out };
  };

  // Пересчёт ячейки: задание (как в тестах инвентаризации), подсчёт
  // грузчиком, «Принять» руководителем.
  const recount = async (cell, lines) => {
    const taskId = await run(async (c) => {
      const r = await c.query('INSERT INTO inventory_runs(warehouse_id) VALUES($1) RETURNING id', [warehouseId]);
      return (await c.query(`INSERT INTO inventory_tasks(run_id,warehouse_id,cell_block_id,reason) VALUES($1,$2,$3,'проверка') RETURNING id`,
        [r.rows[0].id, warehouseId, cell.id])).rows[0].id;
    });
    const opened = await ok('POST', `/api/inventory/tasks/${taskId}/open`, worker);
    await ok('POST', `/api/inventory/tasks/${taskId}/count`, worker, {
      lines: lines.map((l) => ({ sku: l.sku || skus[0][0], companyId: company, quality: l.quality || 'good', qty: l.qty })),
      snapshotId: opened.snapshotId });
    return ok('POST', `/api/inventory/tasks/${taskId}/resolve`, owner, { decision: 'apply' });
  };

  return { owner, warehouseId, run, q, company, seller, worker, manager, cells, vwQty, inCell, receive, recount };
}

// Находка — не исключение на первой проверке, а список расхождений.
function verdicts(title) {
  const bad = [];
  let good = 0;
  return {
    expect(label, isOk, expected, got) {
      if (isOk) { good += 1; console.log(`  ok    ${label}`); return; }
      bad.push(label);
      console.log(`  FAIL  ${label}\n        ожидалось: ${expected}\n        получили:  ${got}`);
    },
    done() {
      console.log(`\n${title}: ${good} выдержало, ${bad.length} нарушений`);
      if (bad.length && process.exitCode !== 2) process.exitCode = 1;
    },
  };
}

const fail = (err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; };

module.exports = { startApp, stand, verdicts, fail, withTenantContext, realFetch };
