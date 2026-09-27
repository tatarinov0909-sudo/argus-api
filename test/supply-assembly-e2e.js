// Сборка поставки со своим состоянием на сервере (задание 27.09.2026):
// старт → выход (пауза) → возврат → отказ → другой грузчик продолжает →
// завершение с комментарием. Плюс: руководитель и менеджер только смотрят,
// чужой склад не видит, «забрать себе», недобор при «Закончить сборку»,
// бумажный лист, лист всей поставки и остаток у заказов.
// Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Supply assembly E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
      name: 'Assembly test', email: `assembly-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Assembly test', city: 'Test',
    }), 201);
    const owner = reg.token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const company = must(await api('POST', '/api/sellers/companies', owner, { name: 'Слим Тест' }), 201).id;
    for (const [sku, name] of [['PB-1', 'Батончик'], ['PB-2', 'Паста']]) {
      must(await api('POST', '/api/products', owner, { sku, name, companyId: company }), 201);
    }
    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 4, tierCount: 1 }] }), 201);
    const cells = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const login = async (name, kind) => {
      const key = must(await api('POST', '/api/staff', owner, { name, ...(kind ? { kind } : {}) }), 201);
      return must(await api('POST', '/api/auth/staff/login', null, { keyCode: key.key_code })).token;
    };
    const dima = await login('Дима');
    const ivan = await login('Иван');
    const manager = await login('Менеджер Ольга', 'manager');

    // На полках: батончик 10, паста 10.
    const receipt = must(await api('POST', '/api/invoices', owner, { companyId: company, number: 'IN-1',
      items: [{ sku: 'PB-1', name: 'Батончик', declaredQty: 10 }, { sku: 'PB-2', name: 'Паста', declaredQty: 10 }] }), 201);
    must(await api('POST', '/api/receiving', dima, { invoiceItemId: receipt.items[0].id, acceptedQty: 10, cellBlockId: cells[0].id }), 201);
    must(await api('POST', '/api/receiving', dima, { invoiceItemId: receipt.items[1].id, acceptedQty: 10, cellBlockId: cells[1].id }), 201);

    let orderNo = 0;
    async function wbOrder(items, companyId = company) {
      orderNo += 1;
      const n = `WB-${orderNo}`;
      const o = must(await api('POST', '/api/invoices', owner, { companyId, number: n, direction: 'out',
        items: items.map(([sku, name, declaredQty]) => ({ sku, name, declaredQty })) }), 201);
      await run((c) => c.query(`UPDATE invoices SET source = 'wb', external_id = $2 WHERE id = $1`, [o.id, n]));
      await run((c) => c.query(`UPDATE invoice_items SET mp_rid = 'rid-' || id WHERE invoice_id = $1`, [o.id]));
      return o;
    }
    const supplyOf = async (orders) => must(await api('POST', '/api/supplies', owner,
      { invoiceIds: orders.map((o) => o.id), marketplace: 'wb' }), 201);
    const journalTexts = async (token = owner) => must(await api('GET', '/api/journal', token)).map((e) => e.action_text);
    const bySupply = async (token, id) => must(await api('GET', '/api/supplies', token)).find((s) => s.id === id);

    // Поставка: батончик 2 + 1, паста 2 + 2 — всего 7 шт.
    const o1 = await wbOrder([['PB-1', 'Батончик', 2], ['PB-2', 'Паста', 2]]);
    const o2 = await wbOrder([['PB-1', 'Батончик', 1], ['PB-2', 'Паста', 2]]);
    const supply = await supplyOf([o1, o2]);
    const num = supply.number;

    const before = must(await api('GET', `/api/shipping/assembly/${supply.id}`, dima));
    must(await api('GET', `/api/shipping/pick-list?supplyId=${supply.id}`, dima));
    check('до старта: состояния нет, взято 0 из 7', () => {
      assert.equal(before.assembly, null);
      assert.equal(before.taken, 0);
      assert.equal(before.total, 7);
    });
    const quiet = await journalTexts();
    check('открыть поставку и лист — не начало сборки: журнал молчит', () => {
      assert.ok(!quiet.some((t) => /начал сборку/.test(t)));
    });

    const byOwner = await api('POST', `/api/shipping/assembly/${supply.id}/start`, owner, {});
    const byManager = await api('POST', `/api/shipping/assembly/${supply.id}/start`, manager, {});
    const managerRead = await api('GET', `/api/shipping/assembly/${supply.id}`, manager);
    check('начать, бросить и закончить сборку может только грузчик; менеджер только смотрит', () => {
      assert.equal(byOwner.status, 403);
      assert.equal(byManager.status, 403);
      assert.equal(managerRead.status, 200);
    });

    // 1. Старт.
    const started = must(await api('POST', `/api/shipping/assembly/${supply.id}/start`, dima, {}), 201);
    check('«Начать»: заход Димы идёт, в журнале «начал сборку … в приложении»', () => {
      assert.equal(started.started, true);
      assert.equal(started.assembly.status, 'active');
      assert.equal(started.assembly.workerName, 'Дима');
      assert.equal(started.assembly.mine, true);
    });
    assert.ok((await journalTexts()).some((t) => t === `Дима начал сборку поставки «${num}» в приложении.`));
    must(await api('POST', '/api/shipping/product', dima,
      { supplyId: supply.id, sku: 'PB-1', cellBlockId: cells[0].id, pickedQty: 3 }), 201);

    // 2. Вышел из сборки — таймер встал сам, руководитель видит это в журнале.
    const exit = must(await api('POST', '/api/journal/pause', dima,
      { supplyId: supply.id, reason: 'Вышел из сборки', exit: true }), 201);
    const managerJournal = await journalTexts(manager);
    const ivanSees = await bySupply(ivan, supply.id);
    check('выход: пауза на сервере, «Дима вышел из сборки …, сборка на паузе, взято 3 из 7» — менеджеру тоже', () => {
      assert.equal(exit.assembly.assembly.status, 'paused');
      assert.ok(exit.assembly.assembly.pausedAt);
      assert.ok(managerJournal.includes(`Дима вышел из сборки поставки «${num}», сборка на паузе, взято 3 из 7 шт.`));
    });
    check('в списке поставок у другого грузчика: на паузе · Дима · взято 3 из 7', () => {
      assert.equal(ivanSees.assembly.assembly.status, 'paused');
      assert.equal(ivanSees.assembly.assembly.workerName, 'Дима');
      assert.equal(ivanSees.assembly.assembly.mine, false);
      assert.equal(ivanSees.assembly.taken, 3);
      assert.equal(ivanSees.assembly.total, 7);
    });
    const exitAgain = await api('POST', '/api/journal/pause', dima, { supplyId: supply.id, reason: 'Вышел из сборки', exit: true });
    check('повторный выход (вторая вкладка, «назад») не плодит записей', () => {
      assert.equal(exitAgain.status, 200);
      assert.equal(exitAgain.body.repeated, true);
    });
    const grab = await api('POST', `/api/shipping/assembly/${supply.id}/start`, ivan, {});
    check('чужую живую сборку молча не начать: 409 «собирает Дима — сборка на паузе»', () => {
      assert.equal(grab.status, 409);
      assert.equal(grab.body.taken, true);
      assert.match(grab.body.error, /собирает Дима — сборка на паузе/);
    });

    // 3. Вернулся. Сдвигаем часы захода: работал 8 минут, на паузе 12.
    await run((c) => c.query(
      `UPDATE work_sessions SET started_at = now() - interval '20 minutes', paused_at = now() - interval '12 minutes'
        WHERE supply_id = $1 AND status = 'paused'`, [supply.id]));
    const firstStart = (await run((c) => c.query(
      'SELECT started_at FROM work_sessions WHERE supply_id = $1', [supply.id]))).rows[0].started_at;
    const back = must(await api('POST', `/api/shipping/assembly/${supply.id}/start`, dima, {}));
    check('возврат: тот же заход, таймер не сброшен — 8 минут работы, 12 паузы', () => {
      assert.equal(back.started, false);
      assert.equal(back.assembly.status, 'active');
      assert.equal(new Date(back.assembly.startedAt).getTime(), new Date(firstStart).getTime());
      assert.ok(Math.abs(back.assembly.pausedMs - 12 * 60000) < 5000, String(back.assembly.pausedMs));
      assert.ok(Math.abs(back.assembly.workMs - 8 * 60000) < 5000, String(back.assembly.workMs));
    });
    assert.ok((await journalTexts()).includes(
      `Дима вернулся к сборке поставки «${num}» после паузы (12 мин: вышел из сборки), взято 3 из 7 шт.`));

    // Пауза с причиной и комментарием — одна запись.
    must(await api('POST', '/api/journal/pause', dima,
      { supplyId: supply.id, reason: 'Перерыв', comment: 'обед, тележка у 2 ряда' }), 201);
    must(await api('POST', '/api/journal/pause', dima, { supplyId: supply.id, reason: 'Перерыв', resumed: true }), 201);
    const pauseTexts = await journalTexts();
    check('пауза с причиной и комментарием — одной записью; возврат — второй', () => {
      assert.ok(pauseTexts.includes(`Дима поставил сборку поставки «${num}» на паузу: Перерыв. Взято 3 из 7 шт. Комментарий: обед, тележка у 2 ряда`));
      assert.ok(pauseTexts.some((t) => t.startsWith(`Дима вернулся к сборке поставки «${num}» после паузы (меньше минуты: Перерыв)`)));
    });

    // 4. Отказ.
    const left = must(await api('POST', `/api/shipping/assembly/${supply.id}/abandon`, dima,
      { comment: '2 короба собраны, стоят у ворот 3' }));
    const ivanSeesFree = await bySupply(ivan, supply.id);
    check('отказ: состояние «брошена», взято 3 из 7, последний комментарий виден другому', () => {
      assert.equal(left.assembly.status, 'abandoned');
      assert.equal(ivanSeesFree.assembly.assembly.status, 'abandoned');
      assert.equal(ivanSeesFree.assembly.taken, 3);
      assert.equal(ivanSeesFree.assembly.lastComment.text, '2 короба собраны, стоят у ворот 3');
      assert.equal(ivanSeesFree.assembly.lastComment.by, 'Дима');
    });
    assert.ok((await journalTexts()).includes(`Дима отказался от сборки поставки «${num}», взято 3 из 7 шт. `
      + 'Поставка свободна — её продолжит любой грузчик с того же места. Комментарий: 2 короба собраны, стоят у ворот 3'));
    const abandonAgain = await api('POST', `/api/shipping/assembly/${supply.id}/abandon`, dima, {});
    check('бросить не свою (уже брошенную) сборку нельзя — 409', () => assert.equal(abandonAgain.status, 409));

    // 5. Другой грузчик продолжает с того же места.
    const ivanStart = must(await api('POST', `/api/shipping/assembly/${supply.id}/start`, ivan, {}), 201);
    check('Иван продолжает: новый заход, взятое Димой засчитано', () => {
      assert.equal(ivanStart.assembly.workerName, 'Иван');
      assert.equal(ivanStart.taken, 3);
    });
    assert.ok((await journalTexts()).includes(`Иван продолжил сборку поставки «${num}» в приложении: взято 3 из 7 шт.`));
    const dimaPick = await api('POST', `/api/shipping/assembly/${supply.id}/finish`, dima, {});
    check('закончить чужую сборку нельзя — 409', () => assert.equal(dimaPick.status, 409));
    must(await api('POST', '/api/shipping/product', ivan,
      { supplyId: supply.id, sku: 'PB-2', cellBlockId: cells[1].id, pickedQty: 4 }), 201);

    // 6. Завершение с комментарием.
    const done = must(await api('POST', `/api/shipping/assembly/${supply.id}/finish`, ivan, { comment: 'коробы у ворот 3' }));
    const finishedTexts = await journalTexts();
    check('завершение: «Иван закончил сборку … взято 7 из 7 шт. Комментарий: коробы у ворот 3»', () => {
      assert.equal(done.assembly.status, 'finished');
      assert.equal(done.assembly.comment, 'коробы у ворот 3');
      assert.equal(done.notTaken.length, 0);
      assert.equal(done.supply.status, 'ready');
      assert.ok(finishedTexts.some((t) => new RegExp(`^Иван закончил сборку поставки «${num}» за \\d+ мин: взято 7 из 7 шт\\. Комментарий: коробы у ворот 3$`).test(t)));
    });
    // Второе нажатие (двойной тап, окно открылось снова) — тот же итог, без
    // второй записи в журнале: застрять на «Закончить» нельзя (задание 27.09-3).
    const doneAgain = await api('POST', `/api/shipping/assembly/${supply.id}/finish`, ivan, {});
    const againTexts = await journalTexts();
    const dimaAgain = await api('POST', `/api/shipping/assembly/${supply.id}/finish`, dima, {});
    check('второй раз «Закончить» — тот же итог без второй записи; чужому — 409', () => {
      assert.equal(doneAgain.status, 200);
      assert.equal(doneAgain.body.assembly.id, done.assembly.id);
      assert.equal(againTexts.filter((t) => t.startsWith(`Иван закончил сборку поставки «${num}»`)).length, 1);
      assert.equal(dimaAgain.status, 409);
    });

    // Лист всей собранной поставки — для печати «с отметками» и «пустого».
    const fullList = must(await api('GET', `/api/shipping/pick-list?supplyId=${supply.id}&full=1`, ivan));
    const openList = must(await api('GET', `/api/shipping/pick-list?supplyId=${supply.id}`, ivan));
    const bar = fullList.lines.find((l) => l.sku === 'PB-1');
    check('лист всей поставки: сколько нужно, сколько взято и из какой ячейки; обычный — пуст', () => {
      assert.equal(fullList.full, true);
      assert.equal(fullList.pickedUnits, 7);
      assert.equal(bar.needQty, 3);
      assert.equal(bar.pickedQty, 3);
      assert.equal(bar.leftQty, 0);
      assert.deepEqual(bar.taken.map((t) => t.qty), [3]);
      assert.match(bar.taken[0].label, /^\d+\.\d+\.\d+$/);
      assert.equal(openList.lines.length, 0);
    });

    // Забрать себе: Дима начал и пропал, Иван забирает — видно в журнале.
    const o3 = await wbOrder([['PB-1', 'Батончик', 1], ['PB-2', 'Паста', 1]]);
    const second = await supplyOf([o3]);
    must(await api('POST', `/api/shipping/assembly/${second.id}/start`, dima, {}), 201);
    const taken = must(await api('POST', `/api/shipping/assembly/${second.id}/start`, ivan, { takeOver: true }), 201);
    const dimaLate = must(await api('POST', '/api/journal/pause', dima, { supplyId: second.id, reason: 'Перерыв' }), 201);
    const dimaExit = must(await api('POST', '/api/journal/pause', dima, { supplyId: second.id, reason: 'Вышел из сборки', exit: true }));
    check('«забрать себе»: заход Ивана, у Димы сборки больше нет — его пауза пишется по-старому, а «вышел» — никак', () => {
      assert.equal(taken.assembly.workerName, 'Иван');
      assert.equal(dimaLate.assembly, undefined);
      assert.equal(dimaExit.repeated, true);
    });
    assert.ok(!(await journalTexts()).some((t) => /Дима поставил работу на паузу: Вышел из сборки/.test(t)));

    // Телефон «заморозил» страницу в фоне: выход записывается временем ухода,
    // но не раньше последнего изменения захода.
    await run((c) => c.query(
      `UPDATE work_sessions SET started_at = now() - interval '30 minutes', updated_at = now() - interval '30 minutes'
        WHERE supply_id = $1 AND status = 'active'`, [second.id]));
    const leftAt = new Date(Date.now() - 10 * 60000).toISOString();
    must(await api('POST', '/api/journal/pause', ivan, { supplyId: second.id, reason: 'Вышел из сборки', exit: true, at: leftAt }), 201);
    const frozen = (await run((c) => c.query(
      `SELECT EXTRACT(EPOCH FROM (now() - paused_at))::int AS ago FROM work_sessions WHERE supply_id = $1 AND status = 'paused'`, [second.id]))).rows[0];
    const frozenTexts = await journalTexts();
    check('выход «задним числом»: пауза с момента ухода (10 мин назад), в журнале — время ухода', () => {
      assert.ok(Math.abs(frozen.ago - 600) < 10, String(frozen.ago));
      assert.ok(frozenTexts.some((t) => new RegExp(`^Иван вышел из сборки поставки «${second.number}» в \\d{2}:\\d{2}, сборка на паузе`).test(t)));
    });
    must(await api('POST', `/api/shipping/assembly/${second.id}/start`, ivan, {}));
    assert.ok((await journalTexts()).includes(`Иван забрал себе сборку поставки «${second.number}», которую вёл Дима `
      + '(сборка шла), и продолжил в приложении: взято 0 из 2 шт.'));

    // «Закончить сборку» с недобором: остаток — отметкой «нет товара».
    must(await api('POST', '/api/shipping/product', ivan,
      { supplyId: second.id, sku: 'PB-1', cellBlockId: cells[0].id, pickedQty: 1 }), 201);
    const partial = must(await api('POST', `/api/shipping/assembly/${second.id}/finish`, ivan, { comment: 'пасты нет на месте' }));
    const urgent = await run((c) => c.query(
      `SELECT je.action_text FROM journal_entries je JOIN invoice_items ii ON ii.id = je.entity_id
        WHERE je.warehouse_id = $1 AND je.urgent AND ii.invoice_id = $2`, [warehouseId, o3.id]));
    check('закончить с тем, что взято: паста ушла «нет товара», поставка ждёт решения', () => {
      assert.deepEqual(partial.notTaken, [{ sku: 'PB-2', name: 'Паста', qty: 1 }]);
      assert.equal(partial.supply.status, 'collecting');
      assert.equal(urgent.rows.length, 1);
      assert.match(urgent.rows[0].action_text, /нет товара «Паста».*при завершении сборки/);
    });
    assert.ok((await journalTexts()).some((t) => t.startsWith(`Иван закончил сборку поставки «${second.number}»`)
      && t.endsWith('взято 1 из 2 шт. Не взято: «Паста» — 1 шт. Руководителю ушло «нет товара». Комментарий: пасты нет на месте')));

    // Бумажный лист: «начал» — только от скана QR (POST /paper/start), один раз.
    const o4 = await wbOrder([['PB-1', 'Батончик', 2]]);
    const third = await supplyOf([o4]);
    must(await api('GET', `/api/shipping/pick-list?supplyId=${third.id}`, dima));
    must(await api('POST', '/api/shipping/paper/start', dima, { supplyId: third.id }), 201);
    const rescan = must(await api('POST', '/api/shipping/paper/start', dima, { supplyId: third.id }), 201);
    const paperStarts = (await journalTexts()).filter((t) => t === `Дима начал сборку поставки «${third.number}» по бумажному листу.`);
    check('лист: «начал по бумажному листу» — одна запись на скан, повторный скан продолжает ту же сборку', () => {
      assert.equal(paperStarts.length, 1);
      assert.equal(rescan.started, false);
      assert.equal(rescan.assembly.mode, 'paper');
    });
    const wrongFinish = await api('POST', `/api/shipping/assembly/${third.id}/finish`, dima, {});
    check('сборку по листу не закончить «Закончить сборку»: взятое по бумаге не ушло бы в «нет товара»', () => {
      assert.equal(wrongFinish.status, 409);
      assert.match(wrongFinish.body.error, /Собрал по листу/);
    });
    await run((c) => c.query(
      `UPDATE work_sessions SET started_at = now() - interval '9 minutes' WHERE supply_id = $1 AND status = 'active'`, [third.id]));
    const paperDone = must(await api('POST', '/api/shipping/paper/finish', dima,
      { supplyId: third.id, notFound: [], comment: 'положил на стол упаковки' }), 201);
    const paperRow = (await run((c) => c.query('SELECT status, comment FROM work_sessions WHERE supply_id = $1', [third.id]))).rows[0];
    check('«собрал по листу»: время — по заходу на сервере, заход закончен, комментарий в итоге', () => {
      assert.equal(paperDone.minutes, 9);
      assert.equal(paperRow.status, 'finished');
      assert.equal(paperRow.comment, 'положил на стол упаковки');
    });
    assert.ok((await journalTexts()).includes(
      `Дима собрал поставку «${third.number}» по бумажному листу за 9 мин: взято 2 шт. Комментарий: положил на стол упаковки`));

    // Поставку с начатой (ничего не взято) сборкой можно разобрать.
    const o5 = await wbOrder([['PB-1', 'Батончик', 1]]);
    const fourth = await supplyOf([o5]);
    must(await api('POST', `/api/shipping/assembly/${fourth.id}/start`, dima, {}), 201);
    const disband = await api('DELETE', `/api/supplies/${fourth.id}`, owner);
    const leftRows = await run((c) => c.query('SELECT count(*)::int AS n FROM work_sessions WHERE supply_id = $1', [fourth.id]));
    check('разобрать поставку с начатой, но пустой сборкой можно — заходы уходят вместе с ней', () => {
      assert.equal(disband.status, 200, JSON.stringify(disband.body));
      assert.equal(leftRows.rows[0].n, 0);
    });

    // Изоляция: чужой склад и продавец.
    const other = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Other', email: `assembly-other-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Other', city: 'Test',
    }), 201).token;
    const otherWarehouse = JSON.parse(Buffer.from(other.split('.')[1], 'base64url')).warehouseId;
    const foreign = await api('GET', `/api/shipping/assembly/${supply.id}`, other);
    const foreignRows = await withTenantContext({ warehouseId: otherWarehouse },
      (c) => c.query('SELECT count(*)::int AS n FROM work_sessions WHERE supply_id = $1', [supply.id]));
    const sellerKey = must(await api('POST', `/api/sellers/companies/${company}/keys`, owner, {}), 201);
    const seller = must(await api('POST', '/api/auth/seller/login', null, { keyCode: sellerKey.key_code, name: 'Test seller' })).token;
    const sellerRows = must(await api('GET', '/api/supplies', seller));
    const sellerDb = await withTenantContext({ companyId: company },
      (c) => c.query('SELECT count(*)::int AS n FROM work_sessions'));
    check('чужой склад сборку не видит; продавцу ни состояния, ни имён грузчиков', () => {
      assert.equal(foreign.status, 404);
      assert.equal(foreignRows.rows[0].n, 0);
      assert.ok(sellerRows.length > 0);
      assert.ok(sellerRows.every((s) => !('assembly' in s)));
      assert.equal(sellerDb.rows[0].n, 0);
    });

    // «На складе, шт.» у заказов с маркетплейса: красный, жёлтый, без цвета.
    const shop = must(await api('POST', '/api/sellers/companies', owner, { name: 'Остатки Тест' }), 201).id;
    for (const [sku, name] of [['ST-0', 'Нет на складе'], ['ST-1', 'Один на три'], ['ST-5', 'Хватает'], ['ST-R', 'Обещан поставке']]) {
      must(await api('POST', '/api/products', owner, { sku, name, companyId: shop }), 201);
    }
    const shopIn = must(await api('POST', '/api/invoices', owner, { companyId: shop, number: 'IN-S',
      items: [{ sku: 'ST-1', name: 'Один на три', declaredQty: 1 }, { sku: 'ST-5', name: 'Хватает', declaredQty: 5 },
        { sku: 'ST-R', name: 'Обещан поставке', declaredQty: 5 }] }), 201);
    must(await api('POST', '/api/receiving', dima, { invoiceItemId: shopIn.items[0].id, acceptedQty: 1, cellBlockId: cells[2].id }), 201);
    must(await api('POST', '/api/receiving', dima, { invoiceItemId: shopIn.items[1].id, acceptedQty: 5, cellBlockId: cells[2].id }), 201);
    must(await api('POST', '/api/receiving', dima, { invoiceItemId: shopIn.items[2].id, acceptedQty: 5, cellBlockId: cells[3].id }), 201);
    const reservedOrder = await wbOrder([['ST-R', 'Обещан поставке', 5]], shop);
    await supplyOf([reservedOrder]);
    await wbOrder([['ST-0', 'Нет на складе', 1]], shop);
    for (let i = 0; i < 3; i += 1) await wbOrder([['ST-1', 'Один на три', 1]], shop);
    await wbOrder([['ST-5', 'Хватает', 2]], shop);
    await wbOrder([['ST-R', 'Обещан поставке', 3]], shop);
    await wbOrder([['NOPE', 'Не сопоставлен', 1]], shop);
    const pending = must(await api('GET', `/api/supplies/pending/${shop}`, manager));
    const row = (sku) => pending.find((o) => o.sku === sku);
    check('остаток у заказа: 0 — красный, 1 на три заказа — жёлтый «1 из 3», хватает — без цвета', () => {
      assert.deepEqual([row('ST-0').stockLevel, row('ST-0').stockQty], ['none', 0]);
      assert.ok(pending.filter((o) => o.sku === 'ST-1').every((o) => o.stockLevel === 'short' && o.stockQty === 1 && o.stockNeed === 3));
      assert.deepEqual([row('ST-5').stockLevel, row('ST-5').stockQty, row('ST-5').stockNeed], ['ok', 5, 2]);
    });
    check('обещанное собираемой поставке тоже считается: 5 на полке, 5 ждёт поставка, ещё 3 — жёлтый', () => {
      assert.deepEqual([row('ST-R').stockLevel, row('ST-R').stockQty, row('ST-R').stockNeed, row('ST-R').stockReserved],
        ['short', 5, 3, 5]);
    });
    check('несопоставленный заказ без цвета: про его остаток склад ничего не знает', () => {
      assert.equal(row('NOPE').stockLevel, null);
      assert.equal(row('NOPE').stockQty, null);
    });

    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error('FAIL', e);
    process.exitCode = 1;
  } finally {
    server.close();
    await require('../src/db/pool').pool.end();
  }
})();
