// Атака: объединение ячеек посреди приёмки теряет укладки.
//
// Остаток ячеек (cell_stock) при объединении переезжает в оставшуюся ячейку
// (POST /api/cells/blocks/merge-rect). Укладки приёмки (receiving_placements,
// 27.09-3; шаги 28.09) — нет: у поглощённой ячейки внешний ключ ON DELETE SET
// NULL, укладка остаётся без ячейки.
//
// Требования: 27.09-3 п. 6 — карточка, история ячейки, «Размещён по ячейкам»
// учитывают все ячейки; 28.09 п. 1 — в «Все товары прихода» видно, что и
// сколько куда положено, у каждой укладки — «Переложить» и «Убрать из ячейки».
const { startApp, setup, verdicts } = require('./_lib');

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('Укладки после объединения ячеек');
  try {
    const s = await setup(ok, { skus: [['A-1', 'Зефир'], ['A-2', 'Пастила']] });
    const w = s.staff['Джоник'];
    const [c1, c2] = [s.cell(1), s.cell(2)];
    const inv = await s.invoice('ПР-АТК-ОБЪЕД', [['A-1', 'Зефир', 10], ['A-2', 'Пастила', 5]]);
    const z = inv.items.find((i) => i.sku === 'A-1').id;
    await ok('POST', `/api/receiving/session/${inv.id}/start`, w, {}, 201);
    await ok('POST', '/api/receiving', w, { invoiceItemId: z, acceptedQty: 10, placements: [{ cellBlockId: c1, qty: 6 }, { cellBlockId: c2, qty: 4 }] }, 201);

    // Руководитель объединяет 1.1.1 и 1.2.1 в одну ячейку.
    const merged = await ok('POST', '/api/cells/blocks/merge-rect', s.token, { rowNum: 1, rackStart: 1, rackEnd: 2, tierStart: 1, tierEnd: 1 }, 201);
    const contents = await ok('GET', `/api/cells/blocks/${merged.id}/contents`, s.token);
    const card = await ok('GET', `/api/invoices/${inv.id}`, s.token);
    const item = card.items.find((i) => i.id === z);
    const layout = item.placements.map((p) => `${p.rowNum == null ? 'без ячейки' : `${p.rowNum}.${p.rackStart}–${p.rackEnd}.${p.tierStart}`} — ${Number(p.qty)}`).join(', ');
    const inMerged = item.placements.filter((p) => p.cellBlockId === merged.id).reduce((a, p) => a + Number(p.qty), 0);

    v.expect('в объединённой ячейке лежат все 10 шт. (остаток переехал)',
      contents.totalUnits === 10, '10', String(contents.totalUnits));
    v.expect('карточка прихода: вся раскладка позиции — в объединённой ячейке (10 шт.)',
      inMerged === 10, '1.1–2.1 — 10 шт.', layout);
    const remove = await api('POST', `/api/receiving/items/${z}/remove`, w, { cellBlockId: merged.id, qty: 10 });
    v.expect('«Убрать из ячейки» все 10 шт., которые эта приёмка положила в (теперь объединённую) ячейку',
      remove.status === 201, '201, осталось разложить 10',
      `${remove.status} «${remove.body && remove.body.error}»`);
  } finally {
    v.done();
    await stop();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
