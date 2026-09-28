// Атака: двойные нажатия и параллельные шаги раскладки (28.09) на одну
// позицию. Проверяем сохранение количества: в ячейках всего ровно принятое,
// раскладка не больше принятого, в 1С — одна приёмка позиции.
const { startApp, setup, verdicts, admin } = require('./_lib');

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('Гонки раскладки');
  try {
    const s = await setup(ok, { skus: [['A-1', 'Зефир'], ['A-2', 'Пастила']], workers: ['Джоник', 'Дима'] });
    const [j, d] = [s.staff['Джоник'], s.staff['Дима']];
    const inv = await s.invoice('ПР-АТК-ГОНКА', [['A-1', 'Зефир', 100], ['A-2', 'Пастила', 5]]);
    const z = inv.items.find((i) => i.sku === 'A-1').id;
    await ok('POST', `/api/receiving/session/${inv.id}/start`, j, {}, 201);

    // Двойное «Принять» с разных телефонов.
    const accept = await Promise.all([j, d, j].map((t) => api('POST', '/api/receiving', t, {
      invoiceItemId: z, acceptedQty: 100, placements: [{ cellBlockId: s.cell(1), qty: 40 }] })));
    v.expect('из трёх одновременных «Принять» прошло одно',
      accept.filter((r) => r.status === 201).length === 1, '1×201', accept.map((r) => r.status).join(','));

    // Остаток 60 — пять одновременных «положить 60».
    const place = await Promise.all([0, 1, 2, 3, 4].map((i) => api('POST', `/api/receiving/items/${z}/place`, i % 2 ? d : j, { cellBlockId: s.cell(2), qty: 60 })));
    v.expect('из пяти одновременных «положить 60» прошло одно',
      place.filter((r) => r.status === 201).length === 1, '1×201', place.map((r) => r.status).join(','));

    // Параллельно: убрать из 1.1.1 и переложить из 1.1.1 — по 30 из 40.
    const mix = await Promise.all([
      api('POST', `/api/receiving/items/${z}/remove`, j, { cellBlockId: s.cell(1), qty: 30 }),
      api('POST', `/api/receiving/items/${z}/move`, d, { fromCellBlockId: s.cell(1), toCellBlockId: s.cell(3), qty: 30 }),
      api('POST', `/api/receiving/items/${z}/remove`, d, { cellBlockId: s.cell(1), qty: 30 }),
    ]);
    const [stock] = await admin('SELECT COALESCE(SUM(qty), 0)::int AS n FROM cell_stock WHERE warehouse_id = $1 AND sku = \'A-1\'', [s.warehouseId]);
    const [placed] = await admin('SELECT COALESCE(SUM(qty), 0)::int AS n FROM receiving_placements WHERE invoice_item_id = $1', [z]);
    const [neg] = await admin(`SELECT count(*)::int AS n FROM (SELECT cell_block_id FROM receiving_placements WHERE invoice_item_id = $1
                                GROUP BY cell_block_id HAVING SUM(qty) < 0) x`, [z]);
    const [outbox] = await admin(`SELECT count(*)::int AS n FROM sync_outbox WHERE warehouse_id = $1 AND payload->'line'->>'id' = $2`, [s.warehouseId, z]);
    v.expect('убрать/переложить 3×30 из 40: прошло не больше одного',
      mix.filter((r) => r.status === 201).length === 1, '1×201', mix.map((r) => r.status).join(','));
    v.expect('ни в одной ячейке раскладка не ушла в минус', neg.n === 0, '0', String(neg.n));
    v.expect('в ячейках лежит ровно разложенное', stock.n === placed.n, `${placed.n}`, `${stock.n}`);
    v.expect('в 1С — одна приёмка позиции', outbox.n === 1, '1', String(outbox.n));
  } finally {
    v.done();
    await stop();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
