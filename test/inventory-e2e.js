// Инвентаризация: назначение, счёт, решение владельца.
//
// Проверяем в первую очередь ограничители, ради которых всё и строилось так:
// работник не начинает пересчёт сам, ячейку не считают чаще положенного,
// заходы не идут подряд, и — главное — расхождение НЕ трогает остаток, пока
// владелец не решил. Ошибка здесь списывает чужой товар со склада.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/inventory-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');

const PORT = 3984;
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

const whIdOf = (token) => JSON.parse(
  Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
).warehouseId;

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Inv Owner', email: `inv${stamp}@test.local`, password: 'secret123',
        warehouseName: 'Inv WH', city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const ownerToken = reg.body.token;
    const warehouseId = whIdOf(ownerToken);
    const run = (fn) => withTenantContext({ warehouseId }, (client) => fn(client));

    const company = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Ромашка' },
    });
    const companyId = company.body.id;

    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'Счётчик' } });
    const workerToken = (await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    })).body.token;

    await api('POST', '/api/cells/rows', {
      token: ownerToken, body: { configs: [{ rackCount: 4, tierCount: 2 }, { rackCount: 4, tierCount: 2 }] },
    });
    const blocks = (await api('GET', '/api/cells/rows', { token: ownerToken }))
      .body.flatMap((r) => r.blocks);

    async function receive(sku, name, qty, cellId, num) {
      const inv = await api('POST', '/api/invoices', {
        token: ownerToken,
        body: { companyId, number: num, direction: 'in', items: [{ name, sku, declaredQty: qty }] },
      });
      const res = await api('POST', '/api/receiving', {
        token: workerToken,
        body: { invoiceItemId: inv.body.items[0].id, acceptedQty: qty, cellBlockId: cellId },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }

    await receive('PB-A', 'Печенье овсяное', 100, blocks[0].id, `ПРХ-A-${stamp}`);
    await receive('PB-B', 'Мармелад', 40, blocks[1].id, `ПРХ-B-${stamp}`);

    // ---------- Работник не начинает пересчёт сам ----------
    const workerRun = await api('POST', '/api/inventory/runs', { token: workerToken, body: {} });
    check('работник не может назначить пересчёт', () => {
      assert.equal(workerRun.status, 403, JSON.stringify(workerRun.body));
    });
    const workerSettings = await api('GET', '/api/inventory/settings', { token: workerToken });
    check('и не может менять правила', () => {
      assert.equal(workerSettings.status, 403, JSON.stringify(workerSettings.body));
    });

    // ---------- Регулировка ----------
    const defaults = await api('GET', '/api/inventory/settings', { token: ownerToken });
    check('у нового склада настройки осторожные по умолчанию', () => {
      assert.equal(defaults.body.recountAfterDays, 90);
      assert.equal(defaults.body.cellsPerRun, 10);
      assert.equal(defaults.body.minDaysBetweenRuns, 7);
    });
    const bad = await api('PATCH', '/api/inventory/settings', {
      token: ownerToken, body: { cellsPerRun: 0 },
    });
    check('нельзя назначить ноль ячеек за заход', () => {
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
    });
    const tuned = await api('PATCH', '/api/inventory/settings', {
      token: ownerToken, body: { cellsPerRun: 2, minDaysBetweenRuns: 7 },
    });
    check('настройки сохраняются, остальные не сбрасываются', () => {
      assert.equal(tuned.body.cellsPerRun, 2);
      assert.equal(tuned.body.recountAfterDays, 90, 'непереданное поле обнулили');
    });

    // ---------- Назначение ----------
    const preview = await api('GET', '/api/inventory/preview', { token: ownerToken });
    check('владелец видит, что уйдёт в работу, до отправки человека', () => {
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body.cells.length, 2, 'норма за заход не соблюдена');
      assert.ok(preview.body.cells[0].reason, 'не сказано, почему выбрана ячейка');
    });

    const created = await api('POST', '/api/inventory/runs', { token: ownerToken, body: {} });
    check('пересчёт назначается ровно на норму', () => {
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.cells.length, 2);
    });

    const again = await api('POST', '/api/inventory/runs', { token: ownerToken, body: {} });
    check('второй заход подряд не назначить', () => {
      assert.equal(again.status, 409, JSON.stringify(again.body));
    });

    // ---------- Счёт ----------
    const tasks = await api('GET', '/api/inventory/tasks', { token: workerToken });
    check('работник видит назначенные задания', () => {
      assert.equal(tasks.status, 200, JSON.stringify(tasks.body));
      assert.equal(tasks.body.length, 2);
    });
    const peek = await api('GET', '/api/inventory/tasks?status=waiting_owner', { token: workerToken });
    check('но не видит того, что ждёт решения владельца', () => {
      assert.equal(peek.status, 403, JSON.stringify(peek.body));
    });

    const withStock = tasks.body.find((t) => t.cellBlockId === blocks[0].id);
    assert.ok(withStock, 'ячейка с товаром не попала в задание');

    const noSnapshot = await api('POST', `/api/inventory/tasks/${withStock.id}/count`, {
      token: workerToken, body: { lines: [] },
    });
    check('считать, не открыв ячейку, нельзя — не с чем сравнивать', () => {
      assert.equal(noSnapshot.status, 409, JSON.stringify(noSnapshot.body));
    });

    const opened = await api('POST', `/api/inventory/tasks/${withStock.id}/open`, { token: workerToken });
    check('при открытии видно, что Аргус ожидает в ячейке', () => {
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.equal(opened.body.expected.length, 1);
      assert.equal(opened.body.expected[0].qty, 100);
    });

    // ---------- Сошлось ----------
    const exact = await api('POST', `/api/inventory/tasks/${withStock.id}/count`, {
      token: workerToken,
      body: { lines: [{ sku: 'PB-A', companyId, quality: 'good', qty: 100 }] },
    });
    check('совпавший пересчёт закрывается сам, без владельца', () => {
      assert.equal(exact.status, 200, JSON.stringify(exact.body));
      assert.equal(exact.body.matched, true);
    });
    const closed = await run((c) => c.query(
      `SELECT status FROM inventory_tasks WHERE id = $1`, [withStock.id],
    ));
    check('и получает состояние «сошлось»', () => {
      assert.equal(closed.rows[0].status, 'matched');
    });

    // ---------- Не сошлось ----------
    const second = tasks.body.find((t) => t.id !== withStock.id);
    await api('POST', `/api/inventory/tasks/${second.id}/open`, { token: workerToken });
    // Работник нашёл в ячейке не то, что числится: чужой товар вместо своего.
    // Это два расхождения сразу — одного не стало, другое появилось.
    const found = await api('POST', `/api/inventory/tasks/${second.id}/count`, {
      token: workerToken,
      body: { lines: [{ sku: 'PB-LOST', companyId, quality: 'good', qty: 7 }] },
    });
    check('расхождение уходит владельцу, а не применяется само', () => {
      assert.equal(found.status, 200, JSON.stringify(found.body));
      assert.equal(found.body.matched, false);
    });

    const stockUntouched = await run((c) => c.query(
      `SELECT COALESCE(SUM(qty), 0) AS qty FROM cell_stock
       WHERE warehouse_id = $1 AND sku = 'PB-LOST'`, [warehouseId],
    ));
    check('до решения владельца остаток не изменился ни на штуку', () => {
      assert.equal(Number(stockUntouched.rows[0].qty), 0, 'пересчёт исправил остаток сам');
    });

    const workerResolve = await api('POST', `/api/inventory/tasks/${second.id}/resolve`, {
      token: workerToken, body: { decision: 'apply' },
    });
    check('работник не может принять собственный пересчёт', () => {
      assert.equal(workerResolve.status, 403, JSON.stringify(workerResolve.body));
    });

    const waiting = await api('GET', '/api/inventory/tasks?status=waiting_owner', { token: ownerToken });
    check('владелец видит, что ждёт его решения', () => {
      assert.equal(waiting.body.length, 1);
      assert.equal(waiting.body[0].id, second.id);
    });

    const applied = await api('POST', `/api/inventory/tasks/${second.id}/resolve`, {
      token: ownerToken, body: { decision: 'apply' },
    });
    check('владелец принимает пересчёт', () => {
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.equal(applied.body.applied, true);
    });
    check('в решении названы обе стороны расхождения', () => {
      const byS = Object.fromEntries(applied.body.changes.map((c) => [c.sku, c]));
      assert.equal(byS['PB-LOST'].diff, 7, 'найденное на полке не показано как прибавка');
      assert.ok(byS['PB-B'], 'исчезнувший товар в расхождении не назван');
      assert.equal(byS['PB-B'].diff, -40, 'списание не показано как убыль');
    });
    const nowStock = await run((c) => c.query(
      `SELECT COALESCE(SUM(qty), 0) AS qty FROM cell_stock
       WHERE warehouse_id = $1 AND sku = 'PB-LOST'`, [warehouseId],
    ));
    check('и только теперь остаток стал таким, как на полке', () => {
      assert.equal(Number(nowStock.rows[0].qty), 7);
    });
    const trail = await run((c) => c.query(
      `SELECT kind, sku, qty, details FROM stock_operations
       WHERE warehouse_id = $1 AND kind = 'inventory'`, [warehouseId],
    ));
    check('исправление видно в общем следе операций', () => {
      assert.equal(trail.rows.length, 2, 'пересчёт изменил остаток без следа');
      const lost = trail.rows.find((r) => r.sku === 'PB-LOST');
      assert.ok(lost, 'найденный товар в следе не назван');
      assert.equal(Number(lost.details.expectedQty), 0);
      assert.equal(Number(lost.details.countedQty), 7);
    });
    const goneStock = await run((c) => c.query(
      `SELECT COALESCE(SUM(qty), 0) AS qty FROM cell_stock
       WHERE warehouse_id = $1 AND sku = 'PB-B'`, [warehouseId],
    ));
    check('то, чего не оказалось на полке, из остатка ушло', () => {
      assert.equal(Number(goneStock.rows[0].qty), 0, 'списанного товара по базе всё ещё 40');
    });

    const twice = await api('POST', `/api/inventory/tasks/${second.id}/resolve`, {
      token: ownerToken, body: { decision: 'apply' },
    });
    check('решить дважды нельзя', () => {
      assert.equal(twice.status, 409, JSON.stringify(twice.body));
    });

    // ---------- Свежепосчитанное не предлагается снова ----------
    await run((c) => c.query(
      `UPDATE inventory_settings SET min_days_between_runs = 0 WHERE warehouse_id = $1`,
      [warehouseId],
    ));
    const nextPreview = await api('GET', '/api/inventory/preview', { token: ownerToken });
    const justCounted = new Set([withStock.cellBlockId, second.cellBlockId]);
    check('ячейку, посчитанную только что, правило не предлагает', () => {
      const repeats = nextPreview.body.cells.filter((c) => justCounted.has(c.cellBlockId));
      assert.deepEqual(repeats, [], 'предложено считать то, что посчитали минуту назад');
    });

    // ---------- Работа в ячейке во время счёта ----------
    const third = nextPreview.body.cells[0];
    const run2 = await api('POST', '/api/inventory/runs', { token: ownerToken, body: {} });
    assert.equal(run2.status, 201, JSON.stringify(run2.body));
    const fresh = (await api('GET', '/api/inventory/tasks', { token: workerToken })).body
      .find((t) => t.cellBlockId === third.cellBlockId);
    await api('POST', `/api/inventory/tasks/${fresh.id}/open`, { token: workerToken });
    await receive('PB-C', 'Пастила', 5, third.cellBlockId, `ПРХ-C-${stamp}`);
    const stale = await api('POST', `/api/inventory/tasks/${fresh.id}/count`, {
      token: workerToken, body: { lines: [] },
    });
    check('счёт, устаревший из-за работы в ячейке, не принимается', () => {
      assert.equal(stale.status, 409, JSON.stringify(stale.body));
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
