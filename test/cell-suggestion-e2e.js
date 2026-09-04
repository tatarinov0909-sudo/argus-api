// Подсказка ячейки: повторяет ли она порядок склада, а не навязывает свой.
//
// Аргус приходит на склад, который уже год работает по своей логике: у
// продавцов сложились ряды, и причины у этого часто физические — колонна,
// сквозняк, привычка. Проверяем именно приоритет: тот же товар → зона этого
// продавца → и только потом любая свободная.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/cell-suggestion-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');

const PORT = 3991;
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

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Sug Owner', email: `sug${stamp}@test.local`, password: 'secret123',
        warehouseName: 'Sug WH', city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const ownerToken = reg.body.token;

    const alpha = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Альфа' } });
    const beta = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Бета' } });
    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'Работник' } });
    const workerToken = (await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    })).body.token;

    // Три ряда по три стеллажа: есть куда разложить «зоны продавцов».
    await api('POST', '/api/cells/rows', {
      token: ownerToken,
      body: { configs: [{ rackCount: 3, tierCount: 1 }, { rackCount: 3, tierCount: 1 }, { rackCount: 3, tierCount: 1 }] },
    });
    const rows = (await api('GET', '/api/cells/rows', { token: ownerToken })).body;
    const rowOf = (n) => rows.find((r) => r.row_num === n).blocks;

    async function receive(companyId, sku, qty, cellId, num) {
      const inv = await api('POST', '/api/invoices', {
        token: ownerToken,
        body: { companyId, number: num, direction: 'in', items: [{ name: 'Товар ' + sku, sku, declaredQty: qty }] },
      });
      const rec = await api('POST', '/api/receiving', {
        token: workerToken,
        body: { invoiceItemId: inv.body.items[0].id, acceptedQty: qty, cellBlockId: cellId },
      });
      assert.equal(rec.status, 201, `receive: ${JSON.stringify(rec.body)}`);
      return inv.body;
    }

    // Склад уже живёт по своему порядку: Альфа во втором ряду, Бета в третьем.
    await receive(alpha.body.id, 'A-1', 10, rowOf(2)[0].id, `IN-A1-${stamp}`);
    await receive(alpha.body.id, 'A-2', 10, rowOf(2)[1].id, `IN-A2-${stamp}`);
    await receive(beta.body.id, 'B-1', 10, rowOf(3)[0].id, `IN-B1-${stamp}`);

    // ---------- Новый товар знакомого продавца ----------
    const forAlpha = await api(
      'GET',
      `/api/agents/kladovshchik/suggest-cell?sku=A-NEW&companyId=${alpha.body.id}`,
      { token: workerToken },
    );
    check('новый товар продавца идёт в его же ряд, а не в первый свободный', () => {
      assert.equal(forAlpha.status, 200, JSON.stringify(forAlpha.body));
      const first = forAlpha.body.options[0];
      assert.ok(first, 'подсказки нет вовсе');
      assert.equal(first.reason, 'near_company', JSON.stringify(forAlpha.body.options));
      assert.ok(first.label.startsWith('2.'), `ожидал второй ряд Альфы, получил ${first.label}`);
    });

    const forBeta = await api(
      'GET',
      `/api/agents/kladovshchik/suggest-cell?sku=B-NEW&companyId=${beta.body.id}`,
      { token: workerToken },
    );
    check('у другого продавца — его собственный ряд', () => {
      const first = forBeta.body.options[0];
      assert.equal(first.reason, 'near_company');
      assert.ok(first.label.startsWith('3.'), `ожидал третий ряд Беты, получил ${first.label}`);
    });

    // ---------- Тот же артикул важнее зоны ----------
    const sameSku = await api(
      'GET',
      `/api/agents/kladovshchik/suggest-cell?sku=A-1&companyId=${alpha.body.id}`,
      { token: workerToken },
    );
    check('к такому же товару докладывают в первую очередь', () => {
      assert.equal(sameSku.body.options[0].reason, 'same_sku', JSON.stringify(sameSku.body.options));
    });

    // ---------- Незнакомый продавец ----------
    const gamma = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Гамма' } });
    const forGamma = await api(
      'GET',
      `/api/agents/kladovshchik/suggest-cell?sku=G-1&companyId=${gamma.body.id}`,
      { token: workerToken },
    );
    check('у продавца без своей зоны — обычная свободная ячейка', () => {
      assert.equal(forGamma.body.options[0].reason, 'empty', JSON.stringify(forGamma.body.options));
    });

    const noCompany = await api('GET', '/api/agents/kladovshchik/suggest-cell?sku=Z-1', { token: workerToken });
    check('старый вызов без companyId не сломался', () => {
      assert.equal(noCompany.status, 200, JSON.stringify(noCompany.body));
      assert.ok(noCompany.body.options.length > 0);
      assert.ok(noCompany.body.options.every((o) => o.reason === 'empty'));
    });

    check('подсказки не повторяют одну ячейку дважды', () => {
      const ids = forAlpha.body.options.map((o) => o.blockId);
      assert.equal(new Set(ids).size, ids.length, JSON.stringify(forAlpha.body.options));
    });

    // ---------- Запись «предложили / выбрали» ----------
    check('подсказка выдаётся вместе с идентификатором', () => {
      assert.ok(forAlpha.body.suggestionId, 'нет suggestionId');
    });

    const inv = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: alpha.body.id, number: `IN-CHOICE-${stamp}`, direction: 'in',
        items: [{ name: 'Товар A-NEW', sku: 'A-NEW', declaredQty: 5 }],
      },
    });
    // Работник кладёт НЕ туда, куда советовали, — это и есть тот факт, ради
    // которого всё писалось.
    const otherCell = rowOf(1)[2];
    const rec = await api('POST', '/api/receiving', {
      token: workerToken,
      body: {
        invoiceItemId: inv.body.items[0].id, acceptedQty: 5,
        cellBlockId: otherCell.id, suggestionId: forAlpha.body.suggestionId,
      },
    });
    check('приёмка принимает ссылку на подсказку', () => {
      assert.equal(rec.status, 201, JSON.stringify(rec.body));
    });

    const decided = await api('GET', '/api/journal', { token: ownerToken });
    check('приёмка при этом не сломалась', () => {
      assert.equal(decided.status, 200);
    });

    const { withTenantContext } = require('../src/db/pool');
    const warehouseId = JSON.parse(
      Buffer.from(ownerToken.split('.')[1], 'base64').toString('utf8'),
    ).warehouseId;
    const stored = await withTenantContext({ warehouseId }, (client) => client.query(
      `SELECT sku, chosen_cell_block_id, decided_at, options FROM cell_suggestions
       WHERE id = $1`,
      [forAlpha.body.suggestionId],
    ));
    check('записано, что предложили и что человек выбрал на самом деле', () => {
      const row = stored.rows[0];
      assert.ok(row, 'подсказка не найдена в базе');
      assert.equal(row.sku, 'A-NEW');
      assert.equal(row.chosen_cell_block_id, otherCell.id, 'должна быть выбранная ячейка, а не предложенная');
      assert.ok(row.decided_at, 'нет отметки времени решения');
      assert.ok(Array.isArray(row.options) && row.options.length > 0, 'не сохранился список предложенного');
    });

    const noRef = await api('POST', '/api/receiving', {
      token: workerToken,
      body: { invoiceItemId: inv.body.items[0].id, acceptedQty: 1, cellBlockId: otherCell.id },
    });
    check('приёмка без ссылки на подсказку не падает (старый экран у работника)', () => {
      // 409 — позиция уже принята; важно, что это не 500 из-за отсутствия ссылки.
      assert.ok([201, 409].includes(noRef.status), JSON.stringify(noRef.body));
    });
  } catch (err) {
    failures.push({ name: 'SETUP', message: err.message });
    console.log(`\n  SETUP ERROR: ${err.message}`);
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  }
  process.exit(failures.length ? 1 : 0);
})();
