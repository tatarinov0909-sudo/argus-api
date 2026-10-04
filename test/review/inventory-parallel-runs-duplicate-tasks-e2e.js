// Проверки последнего запуска и открытых заданий не сериализованы по складу.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp(); const v = verdicts('Два одновременных назначения пересчёта');
  try {
    const s = await stand(app, { racks: 3 });
    let pending;
    await s.run(async c => {
      await c.query('SELECT id FROM warehouses WHERE id=$1 FOR UPDATE', [s.warehouseId]);
      pending = Promise.all([app.api('POST', '/api/inventory/runs', s.owner, {}), app.api('POST', '/api/inventory/runs', s.owner, {})]);
      let waiting = 0;
      for (let n = 0; n < 200; n++) {
        waiting = (await s.q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE '%INSERT INTO inventory_runs%'") )[0].n;
        if (waiting >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (waiting < 2) throw Error('Не синхронизированы две транзакции назначения');
    });
    const result = await pending;
    const tasks = await app.ok('GET', '/api/inventory/tasks', s.worker);
    const counts = Object.values(tasks.reduce((m, t) => { m[t.cellBlockId] = (m[t.cellBlockId] || 0) + 1; return m; }, {}));
    console.log('РЕЗУЛЬТАТ ' + JSON.stringify({ statuses: result.map(r => r.status), tasks: tasks.length, tasksPerCell: counts }));
    v.expect('назначается один пересчёт, второй отклоняется409', result.filter(r => r.status === 201).length === 1 && result.some(r => r.status === 409), '201/409', JSON.stringify(result.map(r => r.status)));
    v.expect('у каждой ячейки одно открытое задание', counts.length === 3 && counts.every(n => n === 1), '[1,1,1]', JSON.stringify(counts));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
