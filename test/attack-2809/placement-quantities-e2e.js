// Атака на количества в новых шагах раскладки (28.09) и в «Принять»:
// ноль, минус, дробь, строки, лишние поля, больше остатка. Мусор — отказ 400,
// а не внутренняя ошибка и не молчаливое округление.
const { startApp, setup, verdicts, admin } = require('./_lib');

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('Количества в раскладке');
  try {
    const s = await setup(ok, { skus: [['A-1', 'Зефир'], ['A-2', 'Пастила']] });
    const w = s.staff['Джоник'];
    const inv = await s.invoice('ПР-АТК-КОЛ', [['A-1', 'Зефир', 50], ['A-2', 'Пастила', 5]]);
    const z = inv.items.find((i) => i.sku === 'A-1').id;
    await ok('POST', `/api/receiving/session/${inv.id}/start`, w, {}, 201);

    const bad = [0, -5, 1.5, 'abc', '', null, 'NaN', 'Infinity', {}, '99999999999999999999'];
    for (const q of bad) {
      const r = await api('POST', '/api/receiving', w, { invoiceItemId: z, acceptedQty: 50, placements: [{ cellBlockId: s.cell(1), qty: q }] });
      v.expect(`первая укладка qty=${JSON.stringify(q)} — отказ 400`, r.status === 400, '400', `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    }
    const accepted = await api('POST', '/api/receiving', w, { invoiceItemId: z, acceptedQty: 50, placements: [{ cellBlockId: s.cell(1), qty: 20, extra: 'x' }], invoiceStatus: 'completed' });
    v.expect('лишние поля не мешают и ничего не меняют', accepted.status === 201 && accepted.body.invoiceStatus === 'in_progress', '201, in_progress', `${accepted.status} ${accepted.body && accepted.body.invoiceStatus}`);

    for (const q of [0, -1, 1.5, 'abc', null, 31, '1e3']) {
      const r = await api('POST', `/api/receiving/items/${z}/place`, w, { cellBlockId: s.cell(2), qty: q });
      v.expect(`«положить» qty=${JSON.stringify(q)} (осталось 30) — отказ 400`, r.status === 400, '400', `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    }
    for (const [path, body] of [
      ['move', { fromCellBlockId: s.cell(1), toCellBlockId: s.cell(2), qty: -3 }],
      ['move', { fromCellBlockId: s.cell(1), toCellBlockId: s.cell(2), qty: 21 }],
      ['move', { fromCellBlockId: 'x', toCellBlockId: s.cell(2), qty: 1 }],
      ['remove', { cellBlockId: s.cell(1), qty: 0 }],
      ['remove', { cellBlockId: s.cell(1), qty: 2.5 }],
      ['remove', { cellBlockId: s.cell(1), qty: 21 }],
    ]) {
      const r = await api('POST', `/api/receiving/items/${z}/${path}`, w, body);
      v.expect(`«${path}» ${JSON.stringify(body.qty)} — отказ 4xx`, r.status >= 400 && r.status < 500, '4xx', `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    }
    // Нестрогие числа requireQty (не 27–28.09) — фиксируем, как ведут себя сейчас.
    const odd = [];
    for (const q of [true, [1], ' 2 ', '0x1']) {
      const r = await api('POST', `/api/receiving/items/${z}/place`, w, { cellBlockId: s.cell(3), qty: q });
      odd.push(`${JSON.stringify(q)} → ${r.status}${r.status === 201 ? ` (положено, осталось ${r.body.unplaced})` : ''}`);
    }
    console.log(`  инфо  нестрогие числа в «положить»: ${odd.join('; ')}`);
    const [stock] = await admin('SELECT COALESCE(SUM(qty), 0)::int AS n FROM cell_stock WHERE warehouse_id = $1', [s.warehouseId]);
    const [placed] = await admin('SELECT COALESCE(SUM(qty), 0)::int AS n FROM receiving_placements WHERE invoice_item_id = $1', [z]);
    v.expect('в ячейках ровно разложенное', stock.n === placed.n, String(placed.n), String(stock.n));
  } finally {
    v.done();
    await stop();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
