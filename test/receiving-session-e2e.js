// Приёмка прихода со своим состоянием на сервере (задание 27.09.2026,
// второе — «приёмка и склад»), по образцу сборки поставки: старт → выход
// (пауза) → возврат → отказ → другой комплектовщик продолжает → «забрать себе» →
// «Закончить приёмку» с не приехавшим. Плюс: список приходов у комплектовщика
// (заказы поставщику скрыты, состояние приёмки видно), руководитель только
// смотрит, чужой склад и продавец не видят, коды товара на экране приёмки,
// полная карточка ячейки. Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Receiving session E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
    const reg = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Receiving test', email: `receiving-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Receiving test', city: 'Test',
    }), 201);
    const owner = reg.token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Слим Тест' }), 201).id;
    for (const [sku, name] of [['RC-1', 'Батончик'], ['RC-2', 'Паста'], ['RC-3', 'Хлебцы']]) {
      must(await api('POST', '/api/products', owner, { sku, name, companyId: company }), 201);
    }
    // Коды товара: штрихкод в карточке и сопоставление с WB (артикул WB).
    await run((c) => c.query(`UPDATE products SET barcode = '4600000000011' WHERE warehouse_id = $1 AND sku = 'RC-1'`, [warehouseId]));
    await run((c) => c.query(
      `INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku, mp_barcode)
       VALUES ($1, $2, 'RC-1', 'wb', '180001001', '2040000000011'), ($1, $2, 'RC-2', 'wb', '180001002', '2040000000028')`,
      [warehouseId, company]));
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 3, tierCount: 2 }] }), 201);
    const cells = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const cellAt = (rack, tier) => cells.find((b) => b.rack_start === rack && b.tier_start === tier);
    const login = async (name, kind) => {
      const key = must(await api('POST', '/api/staff', owner, { name, ...(kind ? { kind } : {}) }), 201);
      return must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
    };
    const dima = await login('Дима');
    const ivan = await login('Иван');
    const manager = await login('Менеджер Ольга', 'manager');
    const journalTexts = async () => must(await api('GET', '/api/journal', owner)).map((e) => e.action_text);

    // Приход на три позиции.
    const inv = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'ПР-ТЕСТ-1',
      items: [{ sku: 'RC-1', name: 'Батончик', declaredQty: 10 }, { sku: 'RC-2', name: 'Паста', declaredQty: 4 },
        { sku: 'RC-3', name: 'Хлебцы', declaredQty: 6 }] }), 201);
    const num = inv.number;
    // Заказ поставщику из 1С — не привоз.
    const order = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'ЗП-1С-1',
      items: [{ sku: 'RC-1', name: 'Батончик', declaredQty: 100 }] }), 201);
    await run((c) => c.query(`UPDATE invoices SET source = '1c', external_id = 'zp-1', source_document_type = 'supplier_order' WHERE id = $1`, [order.id]));

    // ---------- Список у комплектовщика ----------
    const listDima = must(await api('GET', '/api/invoices?direction=in', dima));
    const listOwner = must(await api('GET', '/api/invoices?direction=in', owner));
    check('заказ поставщику комплектовщику не виден, в кабинете — есть', () => {
      assert.ok(!listDima.some((i) => i.id === order.id));
      assert.ok(listOwner.some((i) => i.id === order.id && i.source_document_type === 'supplier_order'));
    });
    check('до старта: приёмки нет, принято 0 из 3 позиций', () => {
      const row = listDima.find((i) => i.id === inv.id);
      assert.equal(row.work.assembly, null);
      assert.equal(row.work.taken, 0);
      assert.equal(row.work.total, 3);
    });
    const detail = must(await api('GET', `/api/invoices/${inv.id}`, dima));
    const item = (sku) => detail.items.find((i) => i.sku === sku);
    check('экран приёмки: штрихкод и артикул WB у позиций', () => {
      const [a, b, c] = ['RC-1', 'RC-2', 'RC-3'].map(item);
      assert.equal(a.barcode, '4600000000011');
      assert.equal(a.wb_article, '180001001');
      assert.equal(b.barcode, '2040000000028');   // в карточке пусто — из сопоставления с WB
      assert.equal(b.wb_article, '180001002');
      assert.equal(c.barcode, null);
      assert.equal(c.wb_article, null);
    });

    // ---------- Старт и выход ----------
    const ownerStart = await api('POST', `/api/receiving/session/${inv.id}/start`, owner, {});
    const mgrState = await api('GET', `/api/receiving/session/${inv.id}`, manager);
    check('руководитель приёмку не начинает; менеджер видит состояние', () => {
      assert.equal(ownerStart.status, 403);
      assert.equal(mgrState.status, 200);
    });
    const started = must(await api('POST', `/api/receiving/session/${inv.id}/start`, dima, {}), 201);
    check('«Начать»: таймер идёт у Димы', () => {
      assert.equal(started.started, true);
      assert.equal(started.kind, 'receiving');
      assert.equal(started.invoice.number, num);
      assert.equal(started.assembly.status, 'active');
      assert.equal(started.assembly.mine, true);
      assert.equal(started.assembly.workerName, 'Дима');
    });
    const startTexts = await journalTexts();
    check('журнал: «начал приёмку прихода»', () => assert.ok(startTexts.includes(`Дима начал приёмку прихода «${num}».`)));
    must(await api('POST', '/api/receiving', dima, { invoiceItemId: item('RC-1').id, acceptedQty: 10, cellBlockId: cellAt(2, 1).id }), 201);

    const exited = must(await api('POST', '/api/journal/pause', dima, { invoiceId: inv.id, reason: 'Вышел из приёмки', exit: true, comment: 'коробы у ворот 2' }), 201);
    check('выход — пауза с записью руководителю: сколько принято и комментарий', () => {
      assert.equal(exited.assembly.assembly.status, 'paused');
      assert.equal(exited.assembly.assembly.pauseReason, 'вышел из приёмки');
      assert.equal(exited.action_text,
        `Дима вышел из приёмки прихода «${num}», приёмка на паузе, принято 1 из 3 позиций. Комментарий: коробы у ворот 2`);
      assert.equal(exited.invoice_id, inv.id);
    });
    const again = must(await api('POST', '/api/journal/pause', dima, { invoiceId: inv.id, reason: 'Вышел из приёмки', exit: true }));
    check('второй выход не пишется', () => assert.equal(again.repeated, true));
    const listPaused = must(await api('GET', '/api/invoices?direction=in', ivan)).find((i) => i.id === inv.id);
    check('в списке у другого комплектовщика: «на паузе · Дима · принято 1 из 3», комментарий', () => {
      assert.equal(listPaused.work.assembly.status, 'paused');
      assert.equal(listPaused.work.assembly.workerName, 'Дима');
      assert.equal(listPaused.work.assembly.mine, false);
      assert.equal(listPaused.work.taken, 1);
      assert.equal(listPaused.work.lastComment.text, 'коробы у ворот 2');
    });

    // ---------- Возврат и отказ ----------
    const resumed = must(await api('POST', `/api/receiving/session/${inv.id}/start`, dima, { comment: 'вернулся' }));
    check('«Продолжить» своей приёмки снимает паузу, время не сбрасывается', () => {
      assert.equal(resumed.started, false);
      assert.equal(resumed.assembly.status, 'active');
      assert.equal(resumed.assembly.startedAt, started.assembly.startedAt);
    });
    assert.ok((await journalTexts()).some((t) => t.startsWith(`Дима вернулся к приёмке прихода «${num}» после паузы`)
      && t.includes('вышел из приёмки') && t.endsWith('Комментарий: вернулся')));
    const notMine = await api('POST', `/api/receiving/session/${inv.id}/abandon`, ivan, {});
    check('отказаться от чужой приёмки нельзя', () => assert.equal(notMine.status, 409));
    const busy = await api('POST', `/api/receiving/session/${inv.id}/start`, ivan, {});
    check('начать чужую — предложение забрать', () => {
      assert.equal(busy.status, 409);
      assert.match(busy.body.error, /принимает Дима.*Забрать приёмку себе/);
    });
    const abandoned = must(await api('POST', `/api/receiving/session/${inv.id}/abandon`, dima, { comment: 'паста в дальнем углу' }));
    check('отказ: приход свободен, принятое записано', () => {
      assert.equal(abandoned.assembly.status, 'abandoned');
      assert.equal(abandoned.taken, 1);
    });
    assert.ok((await journalTexts()).includes(`Дима отказался от приёмки прихода «${num}», принято 1 из 3 позиций.`
      + ' Приход свободен — его продолжит любой комплектовщик с того же места. Комментарий: паста в дальнем углу'));

    // ---------- Иван продолжает, Дима забирает ----------
    must(await api('POST', `/api/receiving/session/${inv.id}/start`, ivan, {}), 201);
    assert.ok((await journalTexts()).includes(`Иван продолжил приёмку прихода «${num}»: принято 1 из 3 позиций.`));
    must(await api('POST', '/api/journal/pause', ivan, { invoiceId: inv.id, reason: 'Перерыв' }), 201);
    const took = must(await api('POST', `/api/receiving/session/${inv.id}/start`, dima, { takeOver: true }), 201);
    check('«забрать себе»: приёмка у Димы, у Ивана закрыта', () => {
      assert.equal(took.assembly.workerName, 'Дима');
      assert.equal(took.assembly.status, 'active');
    });
    assert.ok((await journalTexts()).includes(`Дима забрал себе приёмку прихода «${num}», которую вёл Иван`
      + ' (приёмка была на паузе), и продолжил: принято 1 из 3 позиций.'));
    const ivanExit = must(await api('POST', '/api/journal/pause', ivan, { invoiceId: inv.id, reason: 'Вышел из приёмки', exit: true }));
    check('выход Ивана после того, как забрали, — не событие', () => assert.equal(ivanExit.repeated, true));

    // ---------- Закончить с не приехавшим ----------
    must(await api('POST', '/api/receiving', dima, { invoiceItemId: item('RC-2').id, acceptedQty: 3, cellBlockId: cellAt(2, 1).id }), 201);
    const ivanFinish = await api('POST', `/api/receiving/session/${inv.id}/finish`, ivan, {});
    check('закончить чужую приёмку нельзя', () => assert.equal(ivanFinish.status, 409));
    const finished = must(await api('POST', `/api/receiving/session/${inv.id}/finish`, dima, { comment: 'хлебцы не приехали' }));
    check('«Закончить приёмку»: не приехавшее записано нулём, приход принят', () => {
      assert.equal(finished.assembly.status, 'finished');
      assert.equal(finished.invoice.status, 'completed');
      assert.deepEqual(finished.notArrived, [{ sku: 'RC-3', name: 'Хлебцы', qty: 6 }]);
      assert.equal(finished.taken, 3);
    });
    const texts = await journalTexts();
    check('журнал: итог одной записью и расхождения руководителю', () => {
      assert.ok(texts.some((t) => new RegExp(`^Дима закончил приёмку прихода «${num}» за \\d+ мин: принято 2 из 3 позиций\\.`
        + ' Не приехало: «Хлебцы» — 6 шт\\. Записано расхождением руководителю\\. Комментарий: хлебцы не приехали$').test(t)), texts.join('\n'));
      assert.ok(texts.includes('Нашёл расхождение по «Хлебцы» (RC-3): заявлено 6, по факту 0.'));
      assert.ok(texts.includes('Нашёл расхождение по «Паста» (RC-2): заявлено 4, по факту 3.'));
    });
    const again2 = await api('POST', `/api/receiving/session/${inv.id}/start`, dima, {});
    check('принятый приход заново не начать', () => {
      assert.equal(again2.status, 409);
      assert.match(again2.body.error, /уже принят/);
    });
    const listDone = must(await api('GET', '/api/invoices?direction=in', owner)).find((i) => i.id === inv.id);
    check('кабинет: принятый приход с расхождением помечен', () => assert.equal(listDone.has_discrepancy, true));

    // ---------- Ячейка: полная информация ----------
    const box = must(await api('GET', `/api/cells/blocks/${cellAt(2, 1).id}/contents`, ivan));
    check('карточка ячейки: адрес ряд.стеллаж.ярус, товар, продавец, коды, количество, когда положили', () => {
      assert.equal(box.label, '1.2.1');
      assert.equal(box.totalUnits, 13);
      const bar = box.items.find((i) => i.sku === 'RC-1');
      assert.equal(bar.name, 'Батончик');
      assert.equal(bar.seller, 'Слим Тест');
      assert.equal(bar.barcode, '4600000000011');
      assert.equal(bar.wbArticle, '180001001');
      assert.equal(bar.qty, 10);
      assert.equal(bar.quality, 'good');
      assert.equal(bar.qualityName, 'годный');
      assert.ok(bar.placedAt && Math.abs(new Date(bar.placedAt) - Date.now()) < 60000);
    });
    const byAddr = must(await api('GET', `/api/agents/kladovshchik/find?q=${encodeURIComponent('1.2.1')}`, owner));
    check('поиск по адресу на карте: список пуст, ячейка — отдельно, с её id', () => {
      assert.deepEqual(byAddr.results, []);
      assert.equal(byAddr.cell.cell, '1.2.1');
      assert.equal(byAddr.cell.cellBlockId, cellAt(2, 1).id);
    });

    // ---------- Изоляция ----------
    const other = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Other', email: `receiving-other-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Other', city: 'Test',
    }), 201).token;
    const foreign = await api('GET', `/api/receiving/session/${inv.id}`, other);
    const foreignCell = await api('GET', `/api/cells/blocks/${cellAt(2, 1).id}/contents`, other);
    const sellerKey = must(await api('POST', `/api/sellers/companies/${company}/keys`, owner, {}), 201);
    const seller = must(await api('POST', '/api/auth/seller/login', null, { keyCode: sellerKey.key_code, name: 'Test seller' })).token;
    const sellerList = must(await api('GET', '/api/invoices?direction=in', seller));
    const sellerCell = await api('GET', `/api/cells/blocks/${cellAt(2, 1).id}/contents`, seller);
    const sellerState = await api('GET', `/api/receiving/session/${inv.id}`, seller);
    const managerNoGrant = await api('GET', `/api/cells/blocks/${cellAt(2, 1).id}/contents`, manager);
    check('чужой склад не видит ни приёмки, ни ячейки; продавцу — ни имён комплектовщиков, ни раскладки', () => {
      assert.equal(foreign.status, 404);
      assert.equal(foreignCell.status, 404);
      assert.ok(sellerList.length > 0);
      assert.ok(sellerList.every((i) => !('work' in i)));
      assert.equal(sellerCell.status, 403);
      assert.equal(sellerState.status, 403);
      assert.equal(managerNoGrant.status, 403);
    });

    console.log(`\nПрошли проверки: ${passed}`);
  } catch (err) {
    console.error('FAIL', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    server.close();
    process.exit(process.exitCode || 0);
  }
})();
