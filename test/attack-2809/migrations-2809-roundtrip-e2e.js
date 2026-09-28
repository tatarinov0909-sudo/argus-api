// Атака на миграции 27–28.09: откат и повторный накат с живыми данными
// раскладки. Меняет схему СВОЕЙ тестовой базы и в конце возвращает её
// накатом (node-pg-migrate up). Только на отдельной тестовой базе.
//
// Требование (список проверки): up/down без потери данных. Хендофф 28.09:
// откат 1754403400000 «раскладка та же, история шагов теряется». Хендофф
// 27.09-3: откат 1754403200000 «потеряет раскладку».
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, setup, verdicts, admin } = require('./_lib');

const ROOT = path.join(__dirname, '..', '..');
function migrate(...args) {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'), ...args,
    '-m', 'src/db/migrations', '--no-single-transaction'],
  { cwd: ROOT, env: { ...process.env, DATABASE_URL: process.env.ADMIN_DATABASE_URL }, stdio: 'pipe' });
}
// Откатить до миграции name включительно, сколько бы миграций ни легло после.
async function downTo(name) {
  const applied = (await admin('SELECT name FROM pgmigrations ORDER BY id DESC')).map((r) => r.name);
  const n = applied.indexOf(name) + 1;
  if (!n) throw Error(`Миграция ${name} не накатана`);
  migrate('down', String(n));
}
const layoutOf = async (item) => Object.fromEntries((await admin(
  `SELECT cb.rack_start AS rack, SUM(rp.qty)::int AS qty FROM receiving_placements rp
     JOIN cell_blocks cb ON cb.id = rp.cell_block_id WHERE rp.invoice_item_id = $1
    GROUP BY cb.rack_start HAVING SUM(rp.qty) > 0 ORDER BY 1`, [item])).map((r) => [`1.${r.rack}.1`, r.qty]));
const show = (l) => JSON.stringify(l);

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Миграции раскладки: откат и накат');
  let rolledBack = 0;
  try {
    const s = await setup(ok, { skus: [['A-1', 'Зефир'], ['A-2', 'Пастила']] });
    const w = s.staff['Джоник'];
    const inv = await s.invoice('ПР-АТК-МИГР', [['A-1', 'Зефир', 300], ['A-2', 'Пастила', 5]]);
    const z = inv.items.find((i) => i.sku === 'A-1').id;
    await ok('POST', `/api/receiving/session/${inv.id}/start`, w, {}, 201);
    await ok('POST', '/api/receiving', w, { invoiceItemId: z, acceptedQty: 300, placements: [{ cellBlockId: s.cell(1), qty: 250 }] }, 201);
    await ok('POST', `/api/receiving/items/${z}/place`, w, { cellBlockId: s.cell(2), qty: 50 }, 201);
    await ok('POST', `/api/receiving/items/${z}/move`, w, { fromCellBlockId: s.cell(1), toCellBlockId: s.cell(3), qty: 30 }, 201);
    await ok('POST', `/api/receiving/items/${z}/remove`, w, { cellBlockId: s.cell(2), qty: 20 }, 201);
    const l0 = await layoutOf(z);                       // 220 / 30 / 30, 20 не разложено
    const unplaced0 = 300 - Object.values(l0).reduce((a, n) => a + n, 0);

    await downTo('1754403400000_receiving-placement-steps');
    rolledBack = 1;
    const l1 = await layoutOf(z);
    v.expect('откат шагов (1754403400000): раскладка та же', show(l1) === show(l0), show(l0), show(l1));

    await downTo('1754403200000_receiving-placements');
    rolledBack = 2;
    migrate('up');
    rolledBack = 0;
    const l2 = await layoutOf(z);
    const unplaced2 = 300 - Object.values(l2).reduce((a, n) => a + n, 0);
    const stock = await admin(`SELECT cb.rack_start AS rack, SUM(cs.qty)::int AS qty FROM cell_stock cs JOIN cell_blocks cb ON cb.id = cs.cell_block_id
                                WHERE cs.warehouse_id = $1 AND cs.sku = 'A-1' GROUP BY cb.rack_start ORDER BY 1`, [s.warehouseId]);
    v.expect('откат и накат укладок (1754403200000): раскладка и «не разложено» сохраняются',
      show(l2) === show(l0) && unplaced2 === unplaced0,
      `${show(l0)}, не разложено ${unplaced0}`,
      `${show(l2)}, не разложено ${unplaced2}; а в ячейках на самом деле ${show(Object.fromEntries(stock.map((r) => [`1.${r.rack}.1`, r.qty])))}`);
  } finally {
    // База должна остаться на последней схеме, что бы ни случилось выше.
    if (rolledBack) { try { migrate('up'); } catch (e) { console.error('Не удалось накатить обратно:', e.message); } }
    v.done();
    await stop();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
