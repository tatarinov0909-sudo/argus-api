// Детерминированная гонка двух телефонов. На одноразовой БД задерживаем
// списание исходной строки, чтобы оба запроса успели проверить пустую цель.
// Код приложения не подменяется. Состояние операций меняется только API.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp();
  const v = verdicts('Два параллельных переноса в пустую ячейку');
  let release;
  let held;
  try {
    const s = await stand(app);
    const [A, Z] = s.cells;
    const mk = name => app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name, marketplace: 'wb', keepSeparate: true });
    const a = await mk('Первый');
    const b = await mk('Второй');
    const received = await s.receive([{ qty: 10, cell: A }]);
    if (received.results[0].status !== 201) throw Error('Остаток не принят');
    const transfer = toVw => app.ok('POST', '/api/vwarehouses/transfers', s.manager,
      { companyId: s.company, sku: 'R-1', qty: 5, fromVw: null, toVw });
    const t1 = await transfer(a.id);
    const t2 = await transfer(b.id);
    const tasks = await app.ok('GET', '/api/vwarehouses/move-tasks', s.worker);
    const task1 = tasks.find(t => t.transfer === t1.number);
    const task2 = tasks.find(t => t.transfer === t2.number);
    let locked;
    const lockedPromise = new Promise(r => { locked = r; });
    const releasePromise = new Promise(r => { release = r; });
    held = s.run(async c => {
      await c.query('SELECT id FROM cell_stock WHERE cell_block_id = $1 FOR UPDATE', [A.id]);
      locked();
      await releasePromise;
    });
    await lockedPromise;
    const step = task => app.api('POST', `/api/vwarehouses/move-tasks/${task.id}/step`, s.worker, { toCellBlockId: Z.id, qty: 5 });
    const requests = [step(task1), step(task2)];
    let blocked = 0;
    for (let i = 0; i < 80; i++) {
      const r = await s.q(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
          AND query LIKE '%SELECT id, qty, company_id, virtual_warehouse_id FROM cell_stock%'`);
      blocked = r[0].n;
      if (blocked >= 2) break;
      await new Promise(r => setTimeout(r, 25));
    }
    release();
    await held;
    const results = await Promise.all(requests);
    if (blocked < 2) throw Error('Не удалось воспроизвести пересечение запросов: ' + blocked);
    const target = await s.inCell(Z);
    console.log(JSON.stringify({ requests: results.map(r => r.status), target }));
    v.expect('два склада «хранить отдельно» не смешаны в одной ячейке', Object.keys(target).length <= 1,
      'один запрос отклонён; в ячейке один виртуальный склад', JSON.stringify(target));
    v.expect('сохранён общий остаток 10', Object.values(await s.vwQty()).reduce((x,y)=>x+y,0) === 10, '10', JSON.stringify(await s.vwQty()));
  } catch (e) { fail(e); } finally { if (release) release(); if (held) await held.catch(()=>{}); v.done(); await app.stop(); }
})();
