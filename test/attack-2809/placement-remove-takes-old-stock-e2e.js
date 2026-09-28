// Атака: «Убрать из ячейки» (раскладка приёмки, 28.09) снимает с полки не
// тот товар, что эта приёмка положила, а самый давний того же артикула.
//
// Требование: задание 28.09 п. 1 — «Убрать из ячейки» возвращает штуки ЭТОЙ
// укладки в «осталось разложить»; «Остаток в ячейках, история ячеек,
// placed_at … пересчитываются». Задание 27.09-2 п. 11 и миграция
// 1754403100000: «когда положили» ставится при укладке и дальше не меняется.
//
// Сценарий: в ячейке 1.1.1 с весны лежат 50 шт. (старый приход). Сегодня
// приходом ПР-…-2 туда же положили 100 шт. Грузчик убирает 50 из сегодняшних —
// физически в ячейке остаются 50 весенних и 50 сегодняшних.
const { startApp, setup, verdicts, admin } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('«Убрать из ячейки» и давний товар');
  try {
    const s = await setup(ok, { skus: [['A-1', 'Зефир'], ['A-2', 'Пастила']] });
    const w = s.staff['Джоник'];
    const c1 = s.cell(1);

    const old = await s.invoice('ПР-АТК-ВЕСНА', [['A-1', 'Зефир', 50]]);
    await ok('POST', `/api/receiving/session/${old.id}/start`, w, {}, 201);
    await ok('POST', '/api/receiving', w, { invoiceItemId: old.items[0].id, acceptedQty: 50, cellBlockId: c1 }, 201);
    // Весенняя укладка: время укладки и последнего изменения строки — 1 марта.
    await admin(`UPDATE cell_stock SET placed_at = '2026-03-01T10:00:00Z', updated_at = '2026-03-01T10:00:00Z'
                  WHERE cell_block_id = $1 AND sku = 'A-1'`, [c1]);

    const inv = await s.invoice('ПР-АТК-ОСЕНЬ', [['A-1', 'Зефир', 100], ['A-2', 'Пастила', 5]]);
    const z = inv.items.find((i) => i.sku === 'A-1').id;
    await ok('POST', `/api/receiving/session/${inv.id}/start`, w, {}, 201);
    await ok('POST', '/api/receiving', w, { invoiceItemId: z, acceptedQty: 100, cellBlockId: c1 }, 201);
    const before = await ok('GET', `/api/cells/blocks/${c1}/contents`, s.token);
    await ok('POST', `/api/receiving/items/${z}/remove`, w, { cellBlockId: c1, qty: 50 }, 201);
    const after = await ok('GET', `/api/cells/blocks/${c1}/contents`, s.token);
    const rows = await admin(`SELECT qty, placed_at FROM cell_stock WHERE cell_block_id = $1 AND sku = 'A-1' ORDER BY placed_at`, [c1]);

    const itemB = before.items.find((i) => i.sku === 'A-1');
    const itemA = after.items.find((i) => i.sku === 'A-1');
    v.expect('до «Убрать»: в ячейке 150 шт., первые положены 1 марта',
      itemB && itemB.qty === 150 && String(itemB.firstPlacedAt).startsWith('2026-03-01'),
      '150 шт., firstPlacedAt 2026-03-01', itemB ? `${itemB.qty} шт., firstPlacedAt ${itemB.firstPlacedAt}` : 'нет товара');
    v.expect('после «Убрать 50» из сегодняшней укладки весенние 50 шт. остаются весенними',
      itemA && itemA.qty === 100 && String(itemA.firstPlacedAt).startsWith('2026-03-01'),
      '100 шт., из них 50 положены 1 марта (firstPlacedAt 2026-03-01)',
      itemA ? `${itemA.qty} шт., firstPlacedAt ${new Date(itemA.firstPlacedAt).toISOString()}; строки остатка: `
        + rows.map((r) => `${Number(r.qty)} шт. от ${new Date(r.placed_at).toISOString().slice(0, 10)}`).join(', ')
        : 'нет товара');
  } finally {
    v.done();
    await stop();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
