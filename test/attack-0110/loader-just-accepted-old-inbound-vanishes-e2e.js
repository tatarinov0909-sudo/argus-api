// Ограничение списка грузчика (аудит 30.09: «грузчику не отдаются закрытые
// документы старше 14 дней»; в коде: «он видит работу и десяток недавно
// принятых»). Возраст закрытого документа считается от created_at — от того,
// когда документ ЗАВЕЛИ, а не когда его закрыли.
//
// Приход, который продавец заявил три недели назад (или накладная 1С с
// давней датой), грузчик принимает сегодня — и в ту же секунду приход
// пропадает из его списка: «недавно принятым» он не считается. Так же
// пропадает заказ WB, оформленный больше двух недель назад и уехавший
// сегодня.
//
// Ожидаемо: только что принятый приход остаётся в списке грузчика среди
// недавно принятых.
const { startApp, warehouse, verdicts, admin, fail } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Только что принятый давний приход у грузчика');
  try {
    const ff = await warehouse(ok, 'Ромашка');
    const companyId = (await ok('POST', '/api/sellers/companies', ff.token, { name: 'Продавец' })).id;
    await ok('POST', '/api/products', ff.token, { sku: 'Z-1', name: 'Зефир', companyId });
    await ok('POST', '/api/cells/rows', ff.token, { configs: [{ rackCount: 2, tierCount: 1 }] });
    const cell = (await ok('GET', '/api/cells/rows', ff.token))[0].blocks[0].id;
    const inv = await ok('POST', '/api/invoices', ff.token, { companyId, number: 'ПР-ДАВНИЙ', items: [{ sku: 'Z-1', name: 'Зефир', declaredQty: 5 }] });
    // Приход заявили три недели назад.
    await admin(`UPDATE invoices SET created_at = now() - interval '21 days' WHERE id = $1`, [inv.id]);

    const worker = await ff.worker('Джоник');
    const before = await ok('GET', '/api/invoices', worker);
    v.expect('до приёмки: приход в списке грузчика', before.some((i) => i.id === inv.id), 'есть', 'нет');
    await ok('POST', `/api/receiving/session/${inv.id}/start`, worker, {}, 201);
    await ok('POST', '/api/receiving', worker, { invoiceItemId: inv.items[0].id, acceptedQty: 5, placements: [{ cellBlockId: cell, qty: 5 }] }, 201);
    const [st] = await ff.q('SELECT status FROM invoices WHERE id = $1', [inv.id]);
    v.expect('приход принят целиком (completed)', st.status === 'completed', 'completed', st.status);
    const after = await ok('GET', '/api/invoices', worker);
    v.expect('только что принятый приход остаётся у грузчика среди недавно принятых', after.some((i) => i.id === inv.id),
      'есть в /api/invoices', 'пропал сразу после приёмки');
  } finally {
    v.done();
    await stop();
  }
})().catch(fail);
