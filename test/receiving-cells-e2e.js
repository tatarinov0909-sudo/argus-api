// Третье задание 27.09.2026: приёмка одной позиции в несколько ячеек (сумма,
// расхождение, акт, история ячейки, 1С — одна приёмка), «все позиции приняты
// — заход закрылся сам», защита от зависшего захода (сценарий 27.09: Джоник
// принял 8 из 8, окно «Закончить» закрылось мимо, заход остался на паузе),
// то же у собранной поставки, записка грузчика о товаре «ждёт решения» →
// «Принял к сведению». Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Receiving cells E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
    const register = async (tag) => must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Cells test', email: `cells-${tag}-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Cells test', city: 'Test',
    }), 201).token;
    const owner = await register('a');
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Слим Тест' }), 201).id;
    const products = [['MC-1', 'Зефир ванильный'], ['MC-2', 'Мармелад'], ['MC-3', 'Пастила'], ['MC-4', 'Халва']];
    for (const [sku, name] of products) must(await api('POST', '/api/products', owner, { sku, name, companyId: company }), 201);
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 4, tierCount: 2 }] }), 201);
    const cells = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks.map((b) => ({ ...b, row: r.row_num })));
    const cellAt = (rack, tier) => cells.find((b) => b.rack_start === rack && b.tier_start === tier);
    const [c11, c21, c31, c41] = [cellAt(1, 1), cellAt(2, 1), cellAt(3, 1), cellAt(4, 1)];
    const login = async (token, name, kind) => {
      const key = must(await api('POST', '/api/staff', token, { name, ...(kind ? { kind } : {}) }), 201);
      return must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
    };
    const jonik = await login(owner, 'Джоник');
    const dima = await login(owner, 'Дима');
    const manager = await login(owner, 'Ольга Менеджер', 'manager');
    const journal = async (q = '') => must(await api('GET', `/api/journal${q}`, owner));
    const invoice = async (number, items) => {
      const inv = must(await api('POST', '/api/invoices', owner, { companyId: company, number,
        items: items.map(([sku, qty]) => ({ sku, name: products.find((p) => p[0] === sku)[1], declaredQty: qty })) }), 201);
      return { ...inv, item: (sku) => inv.items.find((i) => i.sku === sku) };
    };

    // ---------- Несколько ячеек ----------
    const inv = await invoice('ПР-ЯЧ-1', [['MC-1', 40], ['MC-2', 10], ['MC-3', 5]]);
    must(await api('POST', `/api/receiving/session/${inv.id}/start`, jonik, {}), 201);
    const post = (token, body) => api('POST', '/api/receiving', token, body);
    const zefir = inv.item('MC-1').id;
    const short = await post(jonik, { invoiceItemId: zefir, acceptedQty: 36, placements: [{ cellBlockId: c11.id, qty: 30 }] });
    const over = await post(jonik, { invoiceItemId: zefir, acceptedQty: 36,
      placements: [{ cellBlockId: c11.id, qty: 30 }, { cellBlockId: c21.id, qty: 10 }] });
    const twice = await post(jonik, { invoiceItemId: zefir, acceptedQty: 36,
      placements: [{ cellBlockId: c11.id, qty: 30 }, { cellBlockId: c11.id, qty: 6 }] });
    const both = await post(jonik, { invoiceItemId: zefir, acceptedQty: 36, cellBlockId: c11.id,
      placements: [{ cellBlockId: c11.id, qty: 36 }] });
    const zeroQty = await post(jonik, { invoiceItemId: zefir, acceptedQty: 36,
      placements: [{ cellBlockId: c11.id, qty: 36 }, { cellBlockId: c21.id, qty: 0 }] });
    const nothing = await post(jonik, { invoiceItemId: zefir, acceptedQty: 0, placements: [{ cellBlockId: c11.id, qty: 1 }] });
    // Чужая ячейка — со склада другого владельца.
    const other = await register('b');
    must(await api('POST', '/api/cells/rows', other, { configs: [{ rackCount: 1, tierCount: 1 }] }), 201);
    const foreign = must(await api('GET', '/api/cells/rows', other))[0].blocks[0];
    const alien = await post(jonik, { invoiceItemId: zefir, acceptedQty: 36,
      placements: [{ cellBlockId: c11.id, qty: 30 }, { cellBlockId: foreign.id, qty: 6 }] });
    check('раскладка не сходится с принятым — отказ с понятным «осталось разложить»', () => {
      assert.equal(short.status, 400);
      assert.equal(short.body.error, 'Разложено 30 из 36 шт. — осталось разложить 6');
      assert.equal(over.status, 400);
      assert.equal(over.body.error, 'Разложено 40 шт., а принято 36 — уберите лишние 4');
      assert.equal(twice.status, 400);
      assert.match(twice.body.error, /указана дважды/);
      assert.equal(both.status, 400);
      assert.equal(zeroQty.status, 400);
      assert.equal(nothing.status, 400);
      assert.equal(alien.status, 404);
    });
    const failedLeftNothing = await run((c) => c.query(
      `SELECT (SELECT count(*)::int FROM receiving_records WHERE invoice_item_id = $1) AS rr,
              (SELECT count(*)::int FROM cell_stock WHERE warehouse_id = $2 AND sku = 'MC-1') AS cs`, [zefir, warehouseId]));
    check('отказ ничего не записал: ни приёмки, ни остатка', () => {
      assert.deepEqual(failedLeftNothing.rows[0], { rr: 0, cs: 0 });
    });

    const placed = must(await post(jonik, { invoiceItemId: zefir, acceptedQty: 36,
      placements: [{ cellBlockId: c11.id, qty: 30 }, { cellBlockId: c21.id, qty: 6 }] }), 201);
    check('36 из 40 в две ячейки: одна приёмка позиции, две укладки по шагам', () => {
      assert.equal(Number(placed.accepted_qty), 36);
      assert.equal(placed.invoiceStatus, 'in_progress');
      assert.equal(placed.finished, null);
      assert.deepEqual(placed.placements.map((p) => [p.label, p.qty, p.step]), [['1.1.1', 30, 1], ['1.2.1', 6, 2]]);
    });
    const db = await run(async (c) => ({
      records: (await c.query('SELECT cell_block_id, accepted_qty FROM receiving_records WHERE invoice_item_id = $1', [zefir])).rows,
      placements: (await c.query(
        'SELECT cell_block_id, qty, step, confirmed_at FROM receiving_placements WHERE invoice_item_id = $1 ORDER BY step', [zefir])).rows,
      stock: (await c.query(
        `SELECT cell_block_id, qty, placed_at FROM cell_stock WHERE warehouse_id = $1 AND sku = 'MC-1' ORDER BY qty DESC`, [warehouseId])).rows,
      outbox: (await c.query(
        `SELECT payload FROM sync_outbox WHERE warehouse_id = $1 AND event_type = 'receiving_completed' AND payload->'line'->>'sku' = 'MC-1'`, [warehouseId])).rows,
    }));
    check('в базе: запись приёмки одна (ячейка — первая), укладок две, строк остатка две', () => {
      assert.equal(db.records.length, 1);
      assert.equal(db.records[0].cell_block_id, c11.id);
      assert.deepEqual(db.placements.map((p) => [p.cell_block_id, Number(p.qty), p.step, p.confirmed_at]),
        [[c11.id, 30, 1, null], [c21.id, 6, 2, null]]);
      assert.deepEqual(db.stock.map((s) => [s.cell_block_id, Number(s.qty)]), [[c11.id, 30], [c21.id, 6]]);
      assert.ok(db.stock.every((s) => s.placed_at));
    });
    check('в 1С уходит одна приёмка позиции — 36 шт.', () => {
      assert.equal(db.outbox.length, 1);
      assert.equal(db.outbox[0].payload.line.actualQty, 36);
      assert.equal(db.outbox[0].payload.line.declaredQty, 40);
    });
    const afterPlace = await journal();
    const diffEntry = afterPlace.find((e) => e.entity_type === 'invoice_item' && e.entity_id === zefir);
    check('журнал: одно расхождение «ждёт решения» с адресами обеих ячеек', () => {
      assert.equal(diffEntry.status, 'pending');
      assert.equal(diffEntry.action_text, 'Нашёл расхождение по «Зефир ванильный» (MC-1): заявлено 40, по факту 36.'
        + ' Разложил по ячейкам: 1.1.1 — 30 шт., 1.2.1 — 6 шт.');
      assert.equal(diffEntry.cell_label, '1.1.1');
      assert.equal(afterPlace.filter((e) => e.entity_id === zefir).length, 1);
    });
    const hist1 = await journal(`?cellBlockId=${c11.id}`);
    const hist2 = await journal(`?cellBlockId=${c21.id}`);
    check('история ячейки: и первая, и вторая ячейка показывают эту приёмку', () => {
      assert.ok(hist1.some((e) => e.id === diffEntry.id));
      const second = hist2.find((e) => e.entity_type === 'receiving_placement');
      assert.ok(second, JSON.stringify(hist2));
      assert.equal(second.action_text, 'Приёмка «ПР-ЯЧ-1»: положено 6 шт. «Зефир ванильный» (MC-1) — часть принятых 36 шт., разложенных по 2 ячейкам.');
      assert.equal(second.actor_name, 'Джоник');
      assert.ok(!hist2.some((e) => e.id === diffEntry.id));
    });
    const cellInfo2 = must(await api('GET', `/api/cells/blocks/${c21.id}/contents`, owner));
    check('«Что здесь» во второй ячейке — 6 шт. зефира с временем укладки', () => {
      const items = cellInfo2.items || cellInfo2.contents || cellInfo2;
      const z = (Array.isArray(items) ? items : []).find((x) => x.sku === 'MC-1');
      assert.ok(z, JSON.stringify(cellInfo2));
      assert.equal(Number(z.qty), 6);
    });
    const detail = must(await api('GET', `/api/invoices/${inv.id}`, jonik));
    check('карточка прихода у грузчика: все укладки позиции с адресами', () => {
      const z = detail.items.find((i) => i.sku === 'MC-1');
      assert.deepEqual(z.placements.map((p) => [p.rowNum, p.rackStart, p.tierStart, Number(p.qty)]), [[1, 1, 1, 30], [1, 2, 1, 6]]);
    });

    // Одна ячейка — как раньше, одним полем.
    must(await post(jonik, { invoiceItemId: inv.item('MC-2').id, acceptedQty: 10, cellBlockId: c31.id }), 201);

    // ---------- Последняя позиция — заход закрылся сам ----------
    const last = must(await post(jonik, { invoiceItemId: inv.item('MC-3').id, acceptedQty: 5, cellBlockId: c41.id }), 201);
    check('последняя позиция: приход принят, заход закрыт в той же транзакции, итог — в ответе', () => {
      assert.equal(last.invoiceStatus, 'completed');
      assert.ok(last.finished);
      assert.equal(last.finished.assembly.status, 'finished');
      assert.equal(last.finished.invoice.status, 'completed');
      assert.equal(last.finished.taken, 3);
      assert.equal(last.finished.total, 3);
      assert.deepEqual(last.finished.notArrived, []);
    });
    const autoTexts = (await journal()).map((e) => e.action_text);
    check('журнал: «закончил приёмку … закрыта сама»', () => {
      assert.ok(autoTexts.some((t) => /^Джоник закончил приёмку прихода «ПР-ЯЧ-1» за \d+ мин: принято 3 из 3 позиций\. Все позиции приняты — приёмка закрыта сама\.$/.test(t)),
        autoTexts.slice(0, 5).join('\n'));
    });
    const lateFinish = must(await api('POST', `/api/receiving/session/${inv.id}/finish`, jonik, { comment: 'всё на местах' }));
    const exitAfter = must(await api('POST', '/api/journal/pause', jonik, { invoiceId: inv.id, reason: 'Вышел из приёмки', exit: true }));
    const again = await post(jonik, { invoiceItemId: inv.item('MC-3').id, acceptedQty: 5, cellBlockId: c41.id });
    check('«Закончить» после автозакрытия не ломается: итог и комментарий; выход — не событие', () => {
      assert.equal(lateFinish.assembly.status, 'finished');
      assert.equal(lateFinish.assembly.comment, 'всё на местах');
      assert.equal(exitAfter.repeated, true);
      assert.equal(again.status, 409);
      assert.equal(again.body.error, 'Эта позиция уже принята');
    });

    // ---------- Акт и кабинет продавца ----------
    const act = must(await api('GET', `/api/acts/receipt/${inv.id}`, owner));
    check('акт приёмки: по позиции — принятое целиком, не по ячейкам', () => {
      const z = act.items.find((i) => i.sku === 'MC-1');
      assert.equal(z.qty, 36);
      assert.equal(z.declared, 40);
      assert.equal(act.items.length, 3);
      assert.equal(act.finished, true);
    });
    const sellerKey = must(await api('POST', `/api/sellers/companies/${company}/keys`, owner, {}), 201);
    const seller = must(await api('POST', '/api/auth/seller/login', null, { keyCode: sellerKey.key_code, name: 'Продавец' })).token;
    const sellerDocs = must(await api('GET', '/api/sellers/documents', seller)).rows || [];
    const sellerInbound = must(await api('GET', `/api/inbound/${inv.id}`, seller));
    const sellerHist = must(await api('GET', `/api/sellers/history?sku=MC-1`, seller));
    const ownerHist = must(await api('GET', `/api/sellers/history?sku=MC-1&companyId=${company}`, owner));
    const sellerDetail = must(await api('GET', `/api/invoices/${inv.id}`, seller));
    check('продавец: «размещён по ячейкам» (неразложенного нет), адресов ячеек не видит', () => {
      const row = sellerDocs.find((d) => d.id === inv.id);
      if (row) assert.equal(Number(row.unplaced_qty || 0), 0);
      assert.equal(sellerInbound.unplaced, 0);
      assert.deepEqual(sellerInbound.notes, []);
      const rec = sellerHist.events.find((e) => e.kind === 'received');
      assert.equal(rec.qty, 36);
      assert.equal(rec.toCells, undefined);
      assert.equal(rec.toCell, undefined);
      assert.ok(sellerDetail.items.every((i) => i.placements === undefined));
    });
    check('склад в истории товара видит обе ячейки приёмки', () => {
      const rec = ownerHist.events.find((e) => e.kind === 'received');
      assert.deepEqual(rec.toCells.map((x) => [x.cell.rackStart, x.qty]), [[1, 30], [2, 6]]);
    });

    // Принято «на своё место» без ячейки — не размещено.
    const loose = await invoice('ПР-ЯЧ-2', [['MC-4', 7], ['MC-2', 1]]);
    must(await post(dima, { invoiceItemId: loose.item('MC-4').id, acceptedQty: 7 }), 201);
    const looseCard = must(await api('GET', `/api/inbound/${loose.id}`, owner));
    check('без ячейки: 7 шт. «без ячейки» в карточке', () => assert.equal(looseCard.unplaced, 7));

    // ---------- Сценарий 27.09: заход завис на паузе у принятого прихода ----------
    const stuck = await invoice('ПР-270926-1', [['MC-2', 3], ['MC-3', 2]]);
    must(await api('POST', `/api/receiving/session/${stuck.id}/start`, jonik, {}), 201);
    must(await post(jonik, { invoiceItemId: stuck.item('MC-2').id, acceptedQty: 3, cellBlockId: c31.id }), 201);
    // Старый экран: последняя позиция принята без захода (так принимал
    // экран до 27.09), а заход остался — как на проде: на паузе.
    await run((c) => c.query(`UPDATE work_sessions SET status = 'finished', ended_at = now() WHERE invoice_id = $1`, [stuck.id]));
    must(await post(jonik, { invoiceItemId: stuck.item('MC-3').id, acceptedQty: 2, cellBlockId: c41.id }), 201);
    await run((c) => c.query(
      `UPDATE work_sessions SET status = 'paused', paused_at = now() - interval '5 minutes', pause_reason = 'вышел из приёмки',
                                ended_at = NULL WHERE invoice_id = $1`, [stuck.id]));
    const before = await run((c) => c.query('SELECT status FROM work_sessions WHERE invoice_id = $1', [stuck.id]));
    check('исходное состояние 27.09: приход принят, заход «на паузе»', () => assert.equal(before.rows[0].status, 'paused'));
    const list = must(await api('GET', '/api/invoices?direction=in', jonik));
    const after = await run((c) => c.query('SELECT status, ended_at FROM work_sessions WHERE invoice_id = $1', [stuck.id]));
    const stuckStart = await api('POST', `/api/receiving/session/${stuck.id}/start`, jonik, {});
    const stuckAgain = await post(jonik, { invoiceItemId: stuck.item('MC-3').id, acceptedQty: 2, cellBlockId: c41.id });
    check('следующее обращение (список приходов) закрыло заход; приход — в принятых', () => {
      assert.equal(after.rows[0].status, 'finished');
      assert.ok(after.rows[0].ended_at);
      assert.equal(list.find((i) => i.id === stuck.id).status, 'completed');
      assert.equal(stuckStart.status, 409);
      assert.equal(stuckStart.body.error, 'Приход «ПР-270926-1» уже принят');
      assert.equal(stuckAgain.status, 409);
    });
    const settleTexts = (await journal()).map((e) => e.action_text);
    check('журнал: зависший заход закрыт с записью от имени Джоника', () => {
      assert.ok(settleTexts.some((t) => /^Джоник закончил приёмку прихода «ПР-270926-1» за \d+ мин: принято 2 из 2 позиций\. Все позиции приняты — приёмка закрыта сама\.$/.test(t)));
    });
    // Тот же случай, но первым обратились к самой работе.
    const stuck2 = await invoice('ПР-270926-5', [['MC-2', 1]]);
    must(await post(dima, { invoiceItemId: stuck2.item('MC-2').id, acceptedQty: 1, cellBlockId: c31.id }), 201);
    await run((c) => c.query(
      `INSERT INTO work_sessions (warehouse_id, kind, invoice_id, worker_key_id, worker_name, status, paused_at, pause_reason)
       SELECT $1, 'receiving', $2, id, name, 'paused', now(), 'вышел из приёмки' FROM staff_keys WHERE warehouse_id = $1 AND name = 'Дима'`,
      [warehouseId, stuck2.id]));
    const st2 = must(await api('GET', `/api/receiving/session/${stuck2.id}`, dima));
    const pause2 = must(await api('POST', '/api/journal/pause', dima, { invoiceId: stuck2.id, reason: 'Вышел из приёмки', exit: true }));
    check('обращение к самой работе тоже закрывает зависший заход', () => {
      assert.equal(st2.assembly.status, 'finished');
      assert.equal(pause2.repeated, true);
    });

    // ---------- Записка грузчика о товаре ----------
    const open = await invoice('ПР-ЯЧ-3', [['MC-1', 4], ['MC-4', 2]]);
    const note = must(await api('POST', '/api/journal/item-note', jonik,
      { invoiceItemId: open.item('MC-4').id, text: '  коробка мятая,\n 2 шт. без плёнки ' }), 201);
    const badNote = await api('POST', '/api/journal/item-note', jonik, { invoiceItemId: open.item('MC-4').id, text: '   ' });
    const ownerNote = await api('POST', '/api/journal/item-note', owner, { invoiceItemId: open.item('MC-4').id, text: 'x' });
    const alienNote = await api('POST', '/api/journal/item-note', jonik, { invoiceItemId: '00000000-0000-4000-8000-000000000000', text: 'x' });
    check('записка о товаре — запись «ждёт решения» с текстом грузчика', () => {
      assert.equal(note.status, 'pending');
      assert.equal(note.entity_type, 'item_note');
      assert.equal(note.invoice_id, open.id);
      assert.equal(note.action_text, 'Джоник пишет о товаре «Халва» (MC-4) в приходе «ПР-ЯЧ-3»: «коробка мятая, 2 шт. без плёнки»');
      assert.equal(badNote.status, 400);
      assert.equal(ownerNote.status, 403);
      assert.equal(alienNote.status, 404);
    });
    const card = must(await api('GET', `/api/inbound/${open.id}`, manager));
    const workerCard = must(await api('GET', `/api/inbound/${open.id}`, jonik));
    check('карточка прихода: записка видна руководителю и менеджеру, не ответлена', () => {
      assert.equal(card.notes.length, 1);
      assert.equal(card.notes[0].text, 'коробка мятая, 2 шт. без плёнки');
      assert.equal(card.notes[0].workerName, 'Джоник');
      assert.equal(card.notes[0].productName, 'Халва');
      assert.equal(card.notes[0].answered, null);
      assert.deepEqual(workerCard.notes, []);
    });
    const wrongWay = await api('POST', `/api/journal/${note.id}/resolve`, owner, { resolution: 'confirm' });
    const ackOnDiff = await api('POST', `/api/journal/${diffEntry.id}/resolve`, owner, { resolution: 'ack' });
    const ack = must(await api('POST', `/api/journal/${note.id}/resolve`, manager, { resolution: 'ack' }), 201);
    const ackTwice = await api('POST', `/api/journal/${note.id}/resolve`, owner, { resolution: 'ack' });
    const cardAfter = must(await api('GET', `/api/inbound/${open.id}`, owner));
    const jAfter = await journal();
    check('«Принял к сведению»: только для записок; один ответ; кто и когда — в карточке', () => {
      assert.equal(wrongWay.status, 400);
      assert.equal(ackOnDiff.status, 400);
      assert.equal(ack.status, 'confirmed');
      assert.equal(ack.action_text, `Принято к сведению менеджером: ${note.action_text}`);
      assert.equal(ackTwice.status, 409);
      assert.equal(cardAfter.notes[0].answered.by, 'Ольга Менеджер');
      assert.equal(jAfter.find((e) => e.id === note.id).answered, true);
    });

    // ---------- Сборка: записка и защита собранной поставки ----------
    const out = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'WB-Z-1', direction: 'out',
      items: [{ sku: 'MC-2', name: 'Мармелад', declaredQty: 1 }] }), 201);
    await run((c) => c.query(`UPDATE invoices SET source = 'wb', external_id = 'WB-Z-1' WHERE id = $1`, [out.id]));
    await run((c) => c.query(`UPDATE invoice_items SET mp_rid = 'rid-' || id WHERE invoice_id = $1`, [out.id]));
    const supply = must(await api('POST', '/api/supplies', owner, { invoiceIds: [out.id], marketplace: 'wb' }), 201);
    must(await api('POST', `/api/shipping/assembly/${supply.id}/start`, dima, {}), 201);
    const asmNote = must(await api('POST', '/api/journal/item-note', dima, { supplyId: supply.id, sku: 'MC-2', text: 'этикетка отклеилась' }), 201);
    const supCard = must(await api('GET', `/api/supplies/${supply.id}`, owner));
    const supSeller = must(await api('GET', `/api/supplies/${supply.id}`, seller)).notes;
    check('записка в сборке — к поставке: видна в её карточке', () => {
      assert.equal(asmNote.action_text, `Дима пишет о товаре «Мармелад» (MC-2) при сборке поставки «${supply.number}»: «этикетка отклеилась»`);
      assert.equal(supCard.notes.length, 1);
      assert.equal(supCard.notes[0].text, 'этикетка отклеилась');
      assert.ok(!supSeller || supSeller.length === 0);
    });
    // Поставка только что собрана, грузчик стоит на окне «Закончить сборку»:
    // чужой список заход у него из-под рук не закрывает.
    await run((c) => c.query(`UPDATE supplies SET status = 'ready', ready_at = now() WHERE id = $1`, [supply.id]));
    must(await api('GET', '/api/supplies', owner));
    const asmFresh = await run((c) => c.query('SELECT status FROM work_sessions WHERE supply_id = $1', [supply.id]));
    check('только что собранная поставка: идущая сборка ждёт «Закончить» грузчика', () => assert.equal(asmFresh.rows[0].status, 'active'));
    // Собрали давно (мимо экрана, как до 27.09), а заход всё «идёт».
    await run((c) => c.query(`UPDATE supplies SET ready_at = now() - interval '1 hour' WHERE id = $1`, [supply.id]));
    must(await api('GET', '/api/supplies', dima));
    const asmAfter = await run((c) => c.query('SELECT status FROM work_sessions WHERE supply_id = $1', [supply.id]));
    const asmFinish = await api('POST', `/api/shipping/assembly/${supply.id}/finish`, dima, { comment: 'всё в коробе' });
    const asmTexts = (await journal()).map((e) => e.action_text);
    check('собранная поставка не держит сборку «идёт»: заход закрыт при обращении к списку', () => {
      assert.equal(asmAfter.rows[0].status, 'finished');
      assert.ok(asmTexts.some((t) => new RegExp(`^Дима закончил сборку поставки «${supply.number}» за \\d+ мин: .* Поставка уже собрана — сборка закрыта сама\\.$`).test(t)));
      // «Закончить сборку» после этого — итог того же захода, не ошибка.
      assert.equal(asmFinish.status, 200, JSON.stringify(asmFinish.body));
      assert.equal(asmFinish.body.assembly.status, 'finished');
      assert.equal(asmFinish.body.assembly.comment, 'всё в коробе');
    });

    // ---------- Журнал: одна работа — один ключ и её состояние ----------
    must(await api('POST', `/api/journal/${diffEntry.id}/resolve`, owner, { resolution: 'confirm' }), 201);
    const feed = await journal();
    const ofInv = feed.filter((e) => e.work_key === `in:${inv.id}`);
    const answer = feed.find((e) => e.related_entry_id === diffEntry.id);
    const ofSupply = feed.filter((e) => e.work_key === `supply:${supply.id}`);
    check('журнал: всё по приходу — под одним ключом работы, с состоянием «принял 3 из 3, расхождений 1»', () => {
      const kinds = new Set(ofInv.map((e) => e.entity_type));
      for (const k of ['receiving_session', 'invoice_item']) assert.ok(kinds.has(k), [...kinds].join(','));
      assert.equal(answer.work_key, `in:${inv.id}`);
      const w = ofInv[0].work;
      assert.deepEqual({ kind: w.kind, number: w.number, done: w.done, taken: w.taken, total: w.total, diffs: w.diffs, workers: w.workers },
        { kind: 'receiving', number: 'ПР-ЯЧ-1', done: true, taken: 3, total: 3, diffs: 1, workers: ['Джоник'] });
      assert.equal(w.session.status, 'finished');
    });
    check('журнал: сборка поставки — начало, записка о товаре и закрытие под ключом поставки', () => {
      const texts = ofSupply.map((e) => e.action_text);
      assert.ok(texts.some((t) => t.startsWith('Дима начал сборку поставки')), texts.join('\n'));
      assert.ok(texts.some((t) => t.startsWith('Дима пишет о товаре')));
      assert.ok(texts.some((t) => t.includes('сборка закрыта сама')));
      const w = ofSupply[0].work;
      assert.equal(w.kind, 'assembly');
      assert.equal(w.done, true);
      assert.equal(w.number, supply.number);
    });
    check('журнал: записи склада и продавца (не работа грузчика) — без ключа работы', () => {
      const created = feed.filter((e) => e.actor_type !== 'worker' && !e.related_entry_id);
      assert.ok(created.every((e) => e.work_key === null));
    });

    console.log(`\n${passed} checks passed`);
  } finally {
    server.close();
    const { pool } = require('../src/db/pool');
    await pool.end().catch(() => {});
  }
})().catch((err) => { console.error(err); process.exit(1); });
