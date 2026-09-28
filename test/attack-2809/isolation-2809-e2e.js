// Атака на изоляцию новых маршрутов 27–28.09: раскладка, записка о товаре,
// ход приёмки, карточка прихода, история ячейки — чужой склад и продавец.
const { startApp, setup, verdicts } = require('./_lib');

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('Изоляция 27–28.09');
  try {
    const a = await setup(ok, { skus: [['A-1', 'Зефир'], ['A-2', 'Пастила']] });
    const b = await setup(ok, { skus: [['A-1', 'Чужой зефир']] });
    const wa = a.staff['Джоник'];
    const wb = b.staff['Джоник'];
    const inv = await a.invoice('ПР-АТК-ИЗО', [['A-1', 'Зефир', 10], ['A-2', 'Пастила', 5]]);
    const z = inv.items.find((i) => i.sku === 'A-1').id;
    await ok('POST', `/api/receiving/session/${inv.id}/start`, wa, {}, 201);
    await ok('POST', '/api/receiving', wa, { invoiceItemId: z, acceptedQty: 10, placements: [{ cellBlockId: a.cell(1), qty: 6 }] }, 201);

    const st = (r) => `${r.status}`;
    const probes = [
      ['чужой грузчик: положить в позицию склада A', await api('POST', `/api/receiving/items/${z}/place`, wb, { cellBlockId: b.cell(1), qty: 1 }), [404]],
      ['чужой грузчик: переложить', await api('POST', `/api/receiving/items/${z}/move`, wb, { fromCellBlockId: a.cell(1), toCellBlockId: b.cell(1), qty: 1 }), [404]],
      ['чужой грузчик: убрать', await api('POST', `/api/receiving/items/${z}/remove`, wb, { cellBlockId: a.cell(1), qty: 1 }), [404]],
      ['свой грузчик: положить в ячейку чужого склада', await api('POST', `/api/receiving/items/${z}/place`, wa, { cellBlockId: b.cell(1), qty: 1 }), [404]],
      ['свой грузчик: переложить в ячейку чужого склада', await api('POST', `/api/receiving/items/${z}/move`, wa, { fromCellBlockId: a.cell(1), toCellBlockId: b.cell(1), qty: 1 }), [404]],
      ['чужой грузчик: записка о товаре склада A', await api('POST', '/api/journal/item-note', wb, { invoiceItemId: z, text: 'проба' }), [404]],
      ['чужой грузчик: ход приёмки склада A', await api('GET', `/api/receiving/session/${inv.id}`, wb), [404]],
      ['чужой грузчик: «Начать» приёмку склада A', await api('POST', `/api/receiving/session/${inv.id}/start`, wb, {}), [404]],
      ['чужой руководитель: карточка прихода A', await api('GET', `/api/invoices/${inv.id}`, b.token), [404]],
      ['чужой руководитель: история ячейки A', await api('GET', `/api/journal?cellBlockId=${a.cell(1)}`, b.token), [200]],
    ];
    for (const [label, r, want] of probes) v.expect(label, want.includes(r.status), want.join('/'), st(r));
    const foreignHistory = probes[probes.length - 1][1].body;
    v.expect('история чужой ячейки пуста', Array.isArray(foreignHistory) && foreignHistory.length === 0, '[]',
      JSON.stringify(foreignHistory).slice(0, 120));

    // Продавец: своё — без адресов ячеек и пауз, чужое — не видно.
    const sellerA = await a.sellerToken(a.company);
    const otherCompany = (await ok('POST', '/api/sellers/companies', a.token, { name: 'Другой продавец' })).id;
    await ok('POST', '/api/products', a.token, { sku: 'O-1', name: 'Чужое', companyId: otherCompany });
    const otherInv = await ok('POST', '/api/invoices', a.token, { companyId: otherCompany, number: 'ПР-АТК-ИЗО-2', items: [{ sku: 'O-1', name: 'Чужое', declaredQty: 3 }] });
    const own = await api('GET', `/api/invoices/${inv.id}`, sellerA);
    const other = await api('GET', `/api/invoices/${otherInv.id}`, sellerA);
    const ownItem = own.body && own.body.items && own.body.items.find((i) => i.id === z);
    const leaked = ownItem ? Object.keys(ownItem).filter((k) => /rack|tier|row_num|placements|pause/.test(k)) : ['нет позиции'];
    v.expect('продавец: свой приход без адресов ячеек и пауз', own.status === 200 && leaked.length === 0, 'нет полей ячеек', leaked.join(', ') || own.status);
    v.expect('продавец: приход другого продавца не виден', other.status === 404, '404', st(other));
    const hist = await api('GET', '/api/sellers/history?sku=A-1', sellerA);
    const histLeak = JSON.stringify(hist.body || {}).match(/toCell|fromCell|rackStart|rowNum/);
    v.expect('продавец: история товара без ячеек', hist.status === 200 && !histLeak, 'без toCell/toCells', histLeak ? histLeak[0] : st(hist));
    const sess = await api('GET', `/api/receiving/session/${inv.id}`, sellerA);
    const jr = await api('GET', '/api/journal', sellerA);
    const contents = await api('GET', `/api/cells/blocks/${a.cell(1)}/contents`, sellerA);
    const placeBySeller = await api('POST', `/api/receiving/items/${z}/place`, sellerA, { cellBlockId: a.cell(2), qty: 1 });
    v.expect('продавец: ход приёмки (имена, паузы) закрыт', sess.status === 403, '403', st(sess));
    v.expect('продавец: журнал закрыт', jr.status === 403, '403', st(jr));
    v.expect('продавец: содержимое ячейки закрыто', [403, 404].includes(contents.status), '403/404', st(contents));
    v.expect('продавец: раскладывать не может', placeBySeller.status === 403, '403', st(placeBySeller));
  } finally {
    v.done();
    await stop();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
