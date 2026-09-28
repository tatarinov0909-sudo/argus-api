// Задание 28.09.2026, п. 1: раскладка принятого по ячейкам шагами. Пришло
// 300 — принято 300, в первую ячейку 250, «осталось разложить 50», вторая
// ячейка; «Закончить приёмку» с неразложенным — нельзя; «Переложить» и
// «Убрать из ячейки» — пока приход не принят; всё разложено — приход принят и
// заход закрыт; после — только через перестановку. Без ячейки принять нельзя.
// Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Receiving steps E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
    const owner = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Steps test', email: `steps-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Steps test', city: 'Test',
    }), 201).token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Слим Шаг' }), 201).id;
    for (const [sku, name] of [['ST-1', 'Зефир'], ['ST-2', 'Пастила']]) {
      must(await api('POST', '/api/products', owner, { sku, name, companyId: company }), 201);
    }
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 4, tierCount: 1 }] }), 201);
    const cells = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const [c1, c2, c3, c4] = [1, 2, 3, 4].map((rack) => cells.find((b) => b.rack_start === rack).id);
    const key = must(await api('POST', '/api/staff', owner, { name: 'Джоник' }), 201);
    const jonik = must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
    const inv = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'ПР-ШАГ-1',
      items: [{ sku: 'ST-1', name: 'Зефир', declaredQty: 300 }, { sku: 'ST-2', name: 'Пастила', declaredQty: 10 }] }), 201);
    const zefir = inv.items.find((i) => i.sku === 'ST-1').id;
    const pastila = inv.items.find((i) => i.sku === 'ST-2').id;
    must(await api('POST', `/api/receiving/session/${inv.id}/start`, jonik, {}), 201);
    const place = (item, body, token = jonik) => api('POST', `/api/receiving/items/${item}/place`, token, body);
    const move = (item, body, token = jonik) => api('POST', `/api/receiving/items/${item}/move`, token, body);
    const remove = (item, body, token = jonik) => api('POST', `/api/receiving/items/${item}/remove`, token, body);
    const stockIn = async (cell) => Number((await run((c) => c.query(
      `SELECT COALESCE(SUM(qty), 0) AS n FROM cell_stock WHERE cell_block_id = $1 AND sku = 'ST-1'`, [cell]))).rows[0].n);

    // ---------- Без ячейки — нельзя ----------
    const noCell = await api('POST', '/api/receiving', jonik, { invoiceItemId: zefir, acceptedQty: 300, cellBlockId: null });
    const tooEarly = await place(zefir, { cellBlockId: c1, qty: 10 });
    check('принять без ячейки — отказ; раскладывать непринятое — отказ', () => {
      assert.equal(noCell.status, 400);
      assert.match(noCell.body.error, /без ячейки принять нельзя/);
      assert.equal(tooEarly.status, 409);
    });

    // ---------- 300 принято, 250 в первую ячейку ----------
    const first = must(await api('POST', '/api/receiving', jonik, { invoiceItemId: zefir, acceptedQty: 300,
      placements: [{ cellBlockId: c1, qty: 250 }] }), 201);
    check('принято 300, в 1.1.1 — 250: осталось разложить 50, приход не принят', () => {
      assert.equal(Number(first.accepted_qty), 300);
      assert.equal(first.unplaced, 50);
      assert.equal(first.invoiceStatus, 'in_progress');
    });
    const finishEarly = await api('POST', `/api/receiving/session/${inv.id}/finish`, jonik, {});
    check('«Закончить приёмку» с неразложенным — отказ: что и сколько не разложено', () => {
      assert.equal(finishEarly.status, 409);
      assert.match(finishEarly.body.error, /Не разложено по ячейкам: «Зефир» — 50 шт\./);
    });
    const tooMuch = await place(zefir, { cellBlockId: c2, qty: 51 });
    const seller = must(await api('POST', `/api/sellers/companies/${company}/keys`, owner, {}), 201);
    const sellerToken = must(await api('POST', '/api/auth/seller/login', null, { keyCode: seller.key_code, name: 'Test seller' })).token;
    const bySeller = await place(zefir, { cellBlockId: c2, qty: 10 }, sellerToken);
    const byOwner = await place(zefir, { cellBlockId: c2, qty: 10 }, owner);
    check('положить больше, чем осталось, — отказ; продавец и руководитель не раскладывают', () => {
      assert.equal(tooMuch.status, 400);
      assert.equal(tooMuch.body.error, 'Осталось разложить 50 шт. — больше положить нельзя');
      assert.equal(bySeller.status, 403);
      assert.equal(byOwner.status, 403);
    });
    const second = must(await place(zefir, { cellBlockId: c2, qty: 50 }), 201);
    check('ещё 50 в 1.2.1 — разложено всё, раскладка по ячейкам', () => {
      assert.equal(second.unplaced, 0);
      assert.deepEqual(second.placements.map((p) => [p.label, p.qty]), [['1.1.1', 250], ['1.2.1', 50]]);
      assert.equal(second.invoiceStatus, 'in_progress');   // Пастила ещё не принята
    });
    const extra = await place(zefir, { cellBlockId: c3, qty: 1 });
    check('разложено всё — класть больше нечего', () => {
      assert.equal(extra.status, 409);
      assert.equal(extra.body.error, 'Всё принятое уже разложено');
    });

    // ---------- Переложить ----------
    const moved = must(await move(zefir, { fromCellBlockId: c1, toCellBlockId: c3, qty: 30 }), 201);
    const sameCell = await move(zefir, { fromCellBlockId: c1, toCellBlockId: c1, qty: 1 });
    const moveTooMuch = await move(zefir, { fromCellBlockId: c2, toCellBlockId: c3, qty: 51 });
    const moveEmpty = await move(zefir, { fromCellBlockId: c4, toCellBlockId: c3, qty: 1 });
    check('переложено: 220 / 50 / 30, неразложенного нет; та же ячейка, больше положенного, пустая — отказ', () => {
      assert.deepEqual(moved.placements.map((p) => [p.label, p.qty]), [['1.1.1', 220], ['1.2.1', 50], ['1.3.1', 30]]);
      assert.equal(moved.unplaced, 0);
      assert.equal(sameCell.status, 400);
      assert.equal(moveTooMuch.status, 400);
      assert.equal(moveEmpty.status, 409);
    });
    const stockAfterMove = [await stockIn(c1), await stockIn(c2), await stockIn(c3)];
    check('в ячейках лежит ровно то же: 220, 50, 30', () => {
      assert.deepEqual(stockAfterMove, [220, 50, 30]);
    });

    // ---------- Убрать из ячейки ----------
    const removed = must(await remove(zefir, { cellBlockId: c2, qty: 20 }), 201);
    const removeTooMuch = await remove(zefir, { cellBlockId: c2, qty: 31 });
    check('«Убрать из ячейки» 20 из 1.2.1 — осталось разложить 20; больше положенного — отказ', () => {
      assert.equal(removed.unplaced, 20);
      assert.deepEqual(removed.placements.map((p) => [p.label, p.qty]), [['1.1.1', 220], ['1.2.1', 30], ['1.3.1', 30]]);
      assert.equal(removeTooMuch.status, 400);
    });
    // Убрали всё из первой ячейки — ячейка записи приёмки переходит на следующую.
    must(await remove(zefir, { cellBlockId: c1, qty: 220 }), 201);
    const recordCell = (await run((c) => c.query('SELECT cell_block_id FROM receiving_records WHERE invoice_item_id = $1', [zefir]))).rows[0];
    check('первая ячейка опустела — запись приёмки ведёт на 1.2.1', () => {
      assert.equal(recordCell.cell_block_id, c2);
    });
    must(await place(zefir, { cellBlockId: c4, qty: 220 }), 201);   // 20 пока не разложено

    const steps = (await run((c) => c.query(
      `SELECT rp.kind, rp.qty, rp.step, rp.cell_block_id, rp.pair_id, pr.step AS pair_step, rp.confirmed_at
         FROM receiving_placements rp LEFT JOIN receiving_placements pr ON pr.id = rp.pair_id
        WHERE rp.invoice_item_id = $1 ORDER BY rp.step`, [zefir]))).rows;
    check('каждое действие — отдельный шаг по порядку: положил, положил, забрал+положил (пара), забрал, забрал, положил', () => {
      assert.deepEqual(steps.map((s) => [s.step, s.kind, Number(s.qty)]), [
        [1, 'put', 250], [2, 'put', 50], [3, 'take', -30], [4, 'put', 30], [5, 'take', -20], [6, 'take', -220], [7, 'put', 220]]);
      assert.equal(steps[3].pair_step, 3);                       // «Переложить» — пара шагов
      assert.ok(steps.every((s) => s.confirmed_at === null));   // скан — позже
    });

    // ---------- Журнал и история ячеек ----------
    const journal = must(await api('GET', '/api/journal', owner));
    const texts = journal.map((e) => e.action_text);
    check('журнал: «положил», «переложил», «убрал» — строками работы грузчика', () => {
      assert.ok(texts.includes('Принял «Зефир» (ST-1) по факту 300 — расхождений не найдено. Положил 250 шт. в ячейку 1.1.1. Осталось разложить 50 шт.'));
      assert.ok(texts.includes('Положил 50 шт. «Зефир» (ST-1) в ячейку 1.2.1. Разложено всё принятое — 300 шт.'));
      assert.ok(texts.includes('Переложил 30 шт. «Зефир» (ST-1) из ячейки 1.1.1 в ячейку 1.3.1.'));
      assert.ok(texts.includes('Убрал 20 шт. «Зефир» (ST-1) из ячейки 1.2.1 — осталось разложить 20 шт.'));
      const steps = journal.filter((e) => e.entity_type === 'receiving_placement');
      assert.ok(steps.every((e) => e.work_key === `in:${inv.id}` && e.category === 'labor'));
    });
    const hist1 = must(await api('GET', `/api/journal?cellBlockId=${c1}`, owner)).map((e) => e.action_text);
    const hist3 = must(await api('GET', `/api/journal?cellBlockId=${c3}`, owner)).map((e) => e.action_text);
    check('история ячеек: из 1.1.1 — «переложено в 1.3.1», в 1.3.1 — «Переложил»', () => {
      assert.ok(hist1.includes('Приёмка «ПР-ШАГ-1»: переложено 30 шт. «Зефир» (ST-1) в ячейку 1.3.1.'));
      assert.ok(hist1.some((t) => t.startsWith('Убрал 220 шт.')));
      assert.ok(hist3.includes('Переложил 30 шт. «Зефир» (ST-1) из ячейки 1.1.1 в ячейку 1.3.1.'));
      assert.equal(hist3.filter((t) => /Переложил|переложено/.test(t)).length, 1);
    });
    const card = must(await api('GET', `/api/invoices/${inv.id}`, owner));
    const zCard = card.items.find((i) => i.id === zefir);
    check('карточка прихода: раскладка по ячейкам и сколько разложено', () => {
      assert.equal(Number(zCard.placed_qty), 280);
      assert.deepEqual(zCard.placements.map((p) => [p.cellBlockId, Number(p.qty)]), [[c2, 30], [c3, 30], [c4, 220]]);
    });

    // ---------- Приход принят, когда всё разложено ----------
    const lastItem = must(await api('POST', '/api/receiving', jonik, { invoiceItemId: pastila, acceptedQty: 10, cellBlockId: c1 }), 201);
    check('последняя позиция принята, но у зефира 20 не разложено — приход не принят', () => {
      assert.equal(lastItem.invoiceStatus, 'in_progress');
      assert.equal(lastItem.finished, null);
    });
    const done = must(await place(zefir, { cellBlockId: c2, qty: 20 }), 201);
    check('разложено всё — приход принят, заход закрыт сам, экран получает итог', () => {
      assert.equal(done.invoiceStatus, 'completed');
      assert.ok(done.finished);
      assert.equal(done.finished.assembly.status, 'finished');
    });
    const afterClose = await move(zefir, { fromCellBlockId: c2, toCellBlockId: c1, qty: 1 });
    const removeAfter = await remove(zefir, { cellBlockId: c2, qty: 1 });
    check('после приёмки — только через «Перепаковка и перестановка»', () => {
      assert.equal(afterClose.status, 409);
      assert.match(afterClose.body.error, /Перепаковка и перестановка/);
      assert.equal(removeAfter.status, 409);
    });
    const finalStock = [await stockIn(c1), await stockIn(c2), await stockIn(c3), await stockIn(c4)];
    check('в ячейках лежит ровно принятое: 0 + 50 + 30 + 220 = 300', () => {
      assert.deepEqual(finalStock, [0, 50, 30, 220]);
    });

    // ---------- Ноль — без ячейки можно ----------
    const inv2 = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'ПР-ШАГ-2',
      items: [{ sku: 'ST-2', name: 'Пастила', declaredQty: 5 }] }), 201);
    must(await api('POST', `/api/receiving/session/${inv2.id}/start`, jonik, {}), 201);
    const zero = must(await api('POST', '/api/receiving', jonik, { invoiceItemId: inv2.items[0].id, acceptedQty: 0 }), 201);
    check('«не приехало» (0) — без ячейки, приход принят', () => {
      assert.equal(zero.unplaced, 0);
      assert.equal(zero.invoiceStatus, 'completed');
    });

    console.log(`\n${passed} checks passed`);
  } finally {
    server.close();
    await require('../src/db/pool').pool.end();
  }
})().catch((err) => { console.error('FAIL', err); process.exitCode = 1; });
