// Первичная загрузка остатков по ячейкам: проверка файла, загрузка, повтор,
// одновременное нажатие, права. Только на отдельной тестовой базе.
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL?.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw new Error('Initial stock E2E requires an isolated test database and ARGUS_TEST_ALLOW_WRITES=1');
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
      name: 'Load test', email: `initial-stock-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Load test', city: 'Test',
    }), 201);
    const other = must(await api('POST', '/api/auth/owner/register', null, {
      name: 'Other', email: `initial-stock-other-${stamp}@test.local`, password: 'test-password-only',
      warehouseName: 'Other', city: 'Test',
    }), 201);
    const owner = reg.token;
    const warehouseId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).warehouseId;
    const run = (fn) => withTenantContext({ warehouseId }, fn);
    const seller = must(await api('POST', '/api/sellers/companies', owner, { name: 'Слим Тест' }), 201).id;
    const rival = must(await api('POST', '/api/sellers/companies', owner, { name: 'Чужой продавец' }), 201).id;
    const foreign = must(await api('POST', '/api/sellers/companies', other.token, { name: 'Другой склад' }), 201).id;
    for (const [sku, company] of [['PB-1', seller], ['PB-2', seller], ['PB-3', seller], ['RIVAL-1', rival]]) {
      must(await api('POST', '/api/products', owner, { sku, name: `Товар ${sku}`, companyId: company }), 201);
    }
    await run((c) => c.query(
      `UPDATE products SET barcode = '4600000000017', stock_qty_1c = 30 WHERE warehouse_id = $1 AND sku = 'PB-2'`,
      [warehouseId],
    ));
    await run((c) => c.query(
      `UPDATE products SET stock_qty_1c = 12 WHERE warehouse_id = $1 AND sku IN ('PB-1', 'PB-3')`, [warehouseId],
    ));

    must(await api('POST', '/api/cells/rows', owner, { configs: [{ rackCount: 3, tierCount: 2 }] }), 201);
    const blocks = must(await api('GET', '/api/cells/rows', owner)).flatMap((r) => r.blocks);
    const at = (rack, tier) => blocks.find((b) => b.rack_start === rack && b.tier_start === tier);
    // Табличка со стеллажа, как на живом складе.
    await run((c) => c.query('UPDATE cell_blocks SET label = $2 WHERE id = $1', [at(3, 2).id, '01-10-015']));
    await run((c) => c.query(
      `INSERT INTO product_cells_1c (warehouse_id, company_id, sku, cell_name) VALUES ($1, $2, 'PB-1', '01-10-015')`,
      [warehouseId, seller],
    ));
    const staff = must(await api('POST', '/api/staff', owner, { name: 'Грузчик' }), 201);
    const worker = must(await api('POST', '/api/auth/staff/login', null, { keyCode: staff.key_code })).token;
    const mgrKey = must(await api('POST', '/api/staff', owner, { name: 'Менеджер', kind: 'manager', permissions: ['warehouse'] }), 201);
    const manager = must(await api('POST', '/api/auth/staff/login', null, { keyCode: mgrKey.key_code })).token;

    const stockRows = () => run((c) => c.query(
      `SELECT cs.cell_block_id, cs.sku, cs.qty::int AS qty, cs.quality, cs.company_id FROM cell_stock cs WHERE cs.warehouse_id = $1`,
      [warehouseId],
    )).then((r) => r.rows);
    const outboxCount = () => run((c) => c.query(
      'SELECT count(*)::int AS n FROM sync_outbox WHERE warehouse_id = $1', [warehouseId],
    )).then((r) => r.rows[0].n);

    // ---------- Права ----------
    for (const [who, token] of [['грузчик', worker], ['менеджер со складом', manager]]) {
      const t = await api('GET', `/api/cells/initial-stock/template?companyId=${seller}`, token);
      const p = await api('POST', '/api/cells/initial-stock', token, { companyId: seller, rows: [{ cell: '1.1.1', sku: 'PB-1', qty: 1 }] });
      check(`${who} не загружает остатки и не берёт бланк`, () => {
        assert.equal(t.status, 403); assert.equal(p.status, 403);
      });
    }
    const foreignTry = await api('POST', '/api/cells/initial-stock', owner, { companyId: foreign, rows: [{ cell: '1.1.1', sku: 'X', qty: 1 }] });
    check('продавец чужого склада не найден', () => assert.equal(foreignTry.status, 404));

    // ---------- Бланк ----------
    const tpl = must(await api('GET', `/api/cells/initial-stock/template?companyId=${seller}`, owner));
    check('бланк: весь каталог продавца, ячейка из 1С подставлена, количество не подставляется', () => {
      assert.deepEqual(tpl.products.map((p) => p.sku).sort(), ['PB-1', 'PB-2', 'PB-3']);
      const p1 = tpl.products.find((p) => p.sku === 'PB-1');
      assert.deepEqual(p1.cells1c, ['01-10-015']);
      assert.equal(p1.stock1c, 12);
      assert.ok(!tpl.products.some((p) => p.sku === 'RIVAL-1'));
    });

    // ---------- Проверка файла ----------
    const messy = [
      { line: 2, cell: '1-10-15', sku: 'pb-1', qty: '7' },                 // табличка без нулей, артикул строчными
      { line: 3, cell: '1.1.1', sku: '4600000000017', qty: '20' },         // наш адрес, штрихкод
      { line: 4, cell: '1.2.1', sku: 'PB-2', qty: '3', quality: 'брак' },
      { line: 5, cell: '1.1.2', sku: 'PB-3', qty: '' },                    // не посчитано — пропуск
      { line: 6, cell: '1.1.2', sku: 'PB-3', qty: '0' },                   // ноль — пропуск
      { line: 7, cell: '1.1.2', sku: 'PB-3', qty: '1,5' },
      { line: 8, cell: '09-09-099', sku: 'PB-3', qty: '1' },
      { line: 9, cell: '1.1.2', sku: 'RIVAL-1', qty: '1' },
      { line: 10, cell: '1.1.1', sku: 'PB-2', qty: '5' },                  // повтор строки 3
      { line: 11, cell: '1.2.2', sku: 'PB-3', qty: '1', seller: 'Чужой продавец' },
      { line: 12, cell: '44927', sku: 'PB-3', qty: '1', cellIsDate: true },
      { line: 13, cell: '1.2.2', sku: 'PB-3', qty: '2', quality: 'хороший' },
    ];
    const before = await outboxCount();
    const preview = must(await api('POST', '/api/cells/initial-stock', owner, { companyId: seller, rows: messy }));
    const err = (n) => preview.lines.find((l) => l.line === n).error || '';
    check('проверка находит табличку без нулей, наш адрес и штрихкод', () => {
      const l2 = preview.lines.find((l) => l.line === 2);
      assert.equal(l2.error, null); assert.equal(l2.sku, 'PB-1'); assert.equal(l2.cellLabel, '1.2.3'); // найдена по табличке, показана адресом «ряд.ярус.ячейка»
      assert.equal(err(3), ''); assert.equal(preview.lines.find((l) => l.line === 3).sku, 'PB-2');
      assert.equal(preview.lines.find((l) => l.line === 4).quality, 'defective');
    });
    check('пустое и нулевое количество — пропуск, а не ошибка', () => {
      assert.equal(preview.summary.skipped, 2);
      assert.ok(!preview.lines.some((l) => l.line === 5 || l.line === 6));
    });
    check('ошибки названы по строкам файла', () => {
      assert.match(err(7), /целым/);
      assert.match(err(8), /на складе нет/);
      assert.match(err(9), /нет товара/);
      assert.match(err(10), /повтор строки 3/);
      assert.match(err(11), /другого продавца/);
      assert.match(err(12), /в дату/);
      assert.match(err(13), /состояние/);
      assert.equal(preview.summary.errors, 7);
      assert.equal(preview.summary.ok, 3);
    });
    check('сверка с 1С: показано, где загружаемое расходится с учётом', () => {
      const pb2 = preview.summary.vs1c.find((v) => v.sku === 'PB-2');
      assert.equal(pb2.loaded, 23); assert.equal(pb2.stock1c, 30);
      assert.equal(preview.summary.notInFile, 1);   // PB-3: 12 по 1С, в файле нет
    });

    const refused = must(await api('POST', '/api/cells/initial-stock', owner, { companyId: seller, rows: messy, apply: true }));
    const afterRefused = await stockRows();
    check('с ошибками не загружается ничего', () => {
      assert.equal(refused.applied, false);
      assert.equal(afterRefused.length, 0);
    });

    // ---------- Загрузка ----------
    const clean = messy.filter((r) => [2, 3, 4, 5].includes(r.line));
    const done = must(await api('POST', '/api/cells/initial-stock', owner, { companyId: seller, rows: clean, apply: true }));
    const stock = await stockRows();
    check('чистый файл загружен: товар в ячейках, своего продавца, в своём состоянии', () => {
      assert.equal(done.applied, true);
      assert.equal(done.summary.units, 30);
      assert.equal(stock.length, 3);
      assert.ok(stock.every((s) => s.company_id === seller));
      assert.deepEqual(stock.find((s) => s.cell_block_id === at(3, 2).id), {
        cell_block_id: at(3, 2).id, sku: 'PB-1', qty: 7, quality: 'good', company_id: seller,
      });
      assert.equal(stock.find((s) => s.cell_block_id === at(1, 2).id).quality, 'defective');
    });
    const ops = await run((c) => c.query(
      `SELECT kind, qty::int AS qty, details FROM stock_operations WHERE warehouse_id = $1`, [warehouseId],
    ));
    const entries = await run((c) => c.query(
      `SELECT action_text, actor_type FROM journal_entries WHERE warehouse_id = $1 AND action_text LIKE 'Загружены остатки%'`,
      [warehouseId],
    ));
    const cellState = await run((c) => c.query('SELECT state FROM cell_blocks WHERE id = $1', [at(3, 2).id]));
    check('след: операция на каждую строку, одна запись в журнале, ячейка занята', () => {
      assert.equal(ops.rows.length, 3);
      assert.ok(ops.rows.every((o) => o.kind === 'initial_load' && o.details.batch === done.batch));
      assert.equal(entries.rows.length, 1);
      assert.equal(entries.rows[0].actor_type, 'owner');
      assert.equal(cellState.rows[0].state, 'occupied');
    });
    const after = await outboxCount();
    check('в очередь для 1С не ушло ничего', () => assert.equal(after, before));

    // ---------- Повтор ----------
    const again = must(await api('POST', '/api/cells/initial-stock', owner, { companyId: seller, rows: clean, apply: true }));
    const afterAgain = await stockRows();
    check('тот же файл второй раз не задваивает: строки узнаны как «уже загружено»', () => {
      assert.equal(again.applied, false);
      assert.equal(again.summary.errors, 0);
      assert.equal(again.summary.already, 3);
      assert.equal(again.summary.ok, 0);
      assert.equal(afterAgain.length, 3);
    });

    // Товар из ячейки забрали (отбор удаляет опустевшую строку) — повторная
    // загрузка всё равно узнаёт строку по истории и не кладёт товар второй раз.
    await run((c) => c.query(
      'DELETE FROM cell_stock WHERE warehouse_id = $1 AND cell_block_id = $2', [warehouseId, at(3, 2).id],
    ));
    const afterPick = must(await api('POST', '/api/cells/initial-stock', owner, { companyId: seller, rows: clean, apply: true }));
    const stillEmpty = (await stockRows()).filter((x) => x.cell_block_id === at(3, 2).id);
    check('ячейку опустошил отбор — повтор файла всё равно не кладёт товар второй раз', () => {
      assert.equal(afterPick.applied, false);
      assert.equal(afterPick.lines.find((l) => l.line === 2).already.length > 0, true);
      assert.equal(stillEmpty.length, 0);
    });
    const otherQty = must(await api('POST', '/api/cells/initial-stock', owner, {
      companyId: seller, rows: [{ cell: '01-10-015', sku: 'PB-1', qty: 9 }],
    }));
    check('та же строка с другим количеством — ошибка «отмените ту загрузку»', () => {
      assert.match(otherQty.lines[0].error, /уже загрузили 7 шт.*отмените/);
    });

    const dotted = must(await api('POST', '/api/cells/initial-stock', owner, {
      companyId: seller, rows: [{ cell: '01.02.001', sku: 'PB-3', qty: 1 }],
    }));
    check('табличка через точки не превращается молча в наш адрес', () => {
      assert.match(dotted.lines[0].error, /через дефис/);
    });

    // Чужой товар в той же ячейке грузить можно: запрет — только на свой лежащий.
    const rivalLoad = must(await api('POST', '/api/cells/initial-stock', owner, {
      companyId: rival, rows: [{ cell: '1.1.1', sku: 'RIVAL-1', qty: 4 }], apply: true,
    }));
    check('другой продавец в ту же ячейку — можно', () => assert.equal(rivalLoad.applied, true));

    // ---------- Одновременное нажатие ----------
    const race = [{ cell: '1.1.2', sku: 'PB-3', qty: 5 }];
    const [a, b] = await Promise.all([
      api('POST', '/api/cells/initial-stock', owner, { companyId: seller, rows: race, apply: true }),
      api('POST', '/api/cells/initial-stock', owner, { companyId: seller, rows: race, apply: true }),
    ]);
    const racedQty = (await stockRows()).filter((s) => s.sku === 'PB-3').reduce((s, r) => s + r.qty, 0);
    check('два одновременных нажатия: загружено один раз', () => {
      assert.equal([a.body.applied, b.body.applied].filter(Boolean).length, 1, JSON.stringify([a.body, b.body]));
      assert.equal(racedQty, 5);
    });

    // ---------- Пересчёт ----------
    const runRow = await run((c) => c.query(
      'INSERT INTO inventory_runs (warehouse_id) VALUES ($1) RETURNING id', [warehouseId],
    ));
    await run((c) => c.query(
      `INSERT INTO inventory_tasks (run_id, warehouse_id, cell_block_id, reason) VALUES ($1, $2, $3, 'тест')`,
      [runRow.rows[0].id, warehouseId, at(2, 2).id],
    ));
    const counting = must(await api('POST', '/api/cells/initial-stock', owner, {
      companyId: seller, rows: [{ cell: '1.2.2', sku: 'PB-3', qty: 1 }],
    }));
    check('в ячейку, где идёт пересчёт, не грузим', () => assert.match(counting.lines[0].error, /пересчёт/));

    // ---------- Отмена загрузки ----------
    const list = must(await api('GET', '/api/cells/initial-stock/batches', owner));
    const first = list.find((x) => x.batch === done.batch);
    const rivalBatch = list.find((x) => x.batch === rivalLoad.batch);
    check('список загрузок: у первой ячейки было движение — отменить нельзя, у чужой — можно', () => {
      assert.equal(first.canUndo, false);      // из 01-10-015 «забрали» товар
      assert.equal(rivalBatch.canUndo, true);
    });
    const refusedUndo = await api('POST', `/api/cells/initial-stock/batches/${done.batch}/undo`, owner);
    check('отмена после того, как товар загрузки трогали, — понятный отказ', () => {
      assert.equal(refusedUndo.status, 409);
      assert.match(refusedUndo.body.error, /трогали/);
      assert.equal(first.blocked, 'touched');
    });

    // Загрузка другого продавца в ту же ячейку отмене не мешает: смотрим
    // только на свой товар, а не на всю ячейку.
    const raceBatch = [a, b].find((x) => x.body.applied).body.batch;
    must(await api('POST', '/api/cells/initial-stock', owner, {
      companyId: rival, rows: [{ cell: '1.1.2', sku: 'RIVAL-1', qty: 2 }], apply: true,
    }));
    const listAfterRival = must(await api('GET', '/api/cells/initial-stock/batches', owner));
    check('чужая загрузка в ту же ячейку не закрывает отмену', () => {
      assert.equal(listAfterRival.find((x) => x.batch === raceBatch).canUndo, true);
    });

    // Брак, посчитанный поверх принятого годного, — это те же штуки.
    await run((c) => c.query(
      `INSERT INTO cell_stock (warehouse_id, company_id, cell_block_id, sku, qty) VALUES ($1, $2, $3, 'PB-1', 10)`,
      [warehouseId, seller, at(2, 1).id],
    ));
    const brakOnTop = must(await api('POST', '/api/cells/initial-stock', owner, {
      companyId: seller, rows: [{ cell: '1.1.2', sku: 'PB-1', qty: 2, quality: 'брак' }],
    }));
    check('брак поверх принятого годного того же товара — «уже лежит», а не новые штуки', () => {
      assert.match(brakOnTop.lines[0].error, /уже лежит 10/);
    });

    // Загружается ровно подтверждённое: план поменялся — ничего не пишем.
    const stale = must(await api('POST', '/api/cells/initial-stock', owner, {
      companyId: seller, rows: [{ cell: '1.1.3', sku: 'PB-3', qty: 1 }], apply: true, expect: { ok: 5, units: 50 },
    }));
    const staleStock = (await stockRows()).filter((x) => x.cell_block_id === at(3, 1).id);
    check('если план изменился после проверки — не загружаем, просим посмотреть снова', () => {
      assert.equal(stale.applied, false); assert.equal(stale.stale, true);
      assert.equal(staleStock.length, 0);
    });
    const outboxBeforeUndo = await outboxCount();
    const undone = must(await api('POST', `/api/cells/initial-stock/batches/${rivalLoad.batch}/undo`, owner));
    const rivalLeft = (await stockRows()).filter((x) => x.sku === 'RIVAL-1' && x.cell_block_id === at(1, 1).id);
    const undoOps = await run((c) => c.query(
      `SELECT count(*)::int AS n FROM stock_operations WHERE warehouse_id = $1 AND kind = 'initial_load_undo'`, [warehouseId],
    ));
    const outboxAfterUndo = await outboxCount();
    check('отмена снимает загруженное, оставляет след и ничего не шлёт в 1С', () => {
      assert.equal(undone.undone, true);
      assert.equal(rivalLeft.length, 0);
      assert.equal(undoOps.rows[0].n, 1);
      assert.equal(outboxAfterUndo, outboxBeforeUndo);
    });
    const twice = await api('POST', `/api/cells/initial-stock/batches/${rivalLoad.batch}/undo`, owner);
    const reload = must(await api('POST', '/api/cells/initial-stock', owner, {
      companyId: rival, rows: [{ cell: '1.1.1', sku: 'RIVAL-1', qty: 4 }], apply: true,
    }));
    check('вторая отмена — отказ; после отмены ту же строку можно загрузить заново', () => {
      assert.equal(twice.status, 409);
      assert.equal(reload.applied, true);
    });
    const byWorker = await api('POST', `/api/cells/initial-stock/batches/${reload.batch}/undo`, worker);
    check('отменяет только владелец', () => assert.equal(byWorker.status, 403));

    // Сверка частями: уже разложенное учитывается.
    const part2 = must(await api('POST', '/api/cells/initial-stock', owner, {
      companyId: seller, rows: [{ cell: '1.1.3', sku: 'PB-2', qty: 7 }],
    }));
    check('сверка с 1С учитывает уже разложенное: 23 в ячейках + 7 = 30 по 1С', () => {
      assert.equal(part2.summary.ok, 1, JSON.stringify(part2.lines));
      assert.ok(!part2.summary.vs1c.some((v) => v.sku === 'PB-2'), JSON.stringify(part2.summary.vs1c));
    });

    // ---------- Кривой запрос ----------
    const empty = await api('POST', '/api/cells/initial-stock', owner, { companyId: seller, rows: [] });
    const huge = await api('POST', '/api/cells/initial-stock', owner, {
      companyId: seller, rows: Array.from({ length: 5001 }, () => ({ cell: '1.1.1', sku: 'PB-1', qty: 1 })),
    });
    const noSeller = await api('POST', '/api/cells/initial-stock', owner, { rows: [{ cell: '1.1.1', sku: 'PB-1', qty: 1 }] });
    check('пустой файл, слишком большой файл и без продавца — понятный отказ', () => {
      assert.equal(empty.status, 400); assert.equal(huge.status, 400); assert.equal(noSeller.status, 400);
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
