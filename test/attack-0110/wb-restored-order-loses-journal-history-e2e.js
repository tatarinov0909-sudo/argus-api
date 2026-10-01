// Склады WB: заказ «возвращается тем же» (хендофф 30.09-2: «убранный заказ
// хранится целиком и возвращается тем же — номер записи, даты, статус WB»),
// но его история в журнале теряется.
//
// settle() убирает заказ строкой DELETE FROM invoices; у journal_entries
// ссылка invoice_id — ON DELETE SET NULL. Снимок в wb_foreign_orders хранит
// строку заказа, но не ссылки журнала: заказ возвращается с тем же id, а
// «История документа» (GET /api/journal?invoiceId=) у него пуста навсегда.
// Ровно эту потерю («ссылки старых записей журнала на них потеряны») снимок и
// должен был устранить.
//
// Сценарий: заказ был в поставке, по нему отметили «нет товара», менеджер
// убрал его из поставки — в журнале две записи о нём. Потом склад WB сняли с
// отметки и вернули.
const { WB, order, startApp, warehouse, verdicts, fail } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('История заказа после возврата');
  try {
    const ff = await warehouse(ok, 'Восход');
    const s = await ff.seller('Авезов', 'avezov', [
      { id: 11, name: 'ФФ Восход Москва', officeId: 500 },
      { id: 12, name: 'ФФ Другой', officeId: 900 },
    ]);
    WB.queue.avezov = [order(8101, 11), order(8102, 11)];
    await ff.sync(s.companyId);
    const ids = await ff.q(`SELECT id, external_id FROM invoices WHERE company_id = $1 ORDER BY external_id`, [s.companyId]);
    const id8101 = ids.find((r) => r.external_id === '8101').id;
    await ok('POST', '/api/supplies', ff.token, { invoiceIds: ids.map((r) => r.id), marketplace: 'wb', destination: 'Коледино' }, 201);
    await ok('POST', `/api/supplies/orders/${id8101}/remove`, ff.token, {});
    const hist0 = await ok('GET', `/api/journal?invoiceId=${id8101}`, ff.token);
    v.expect('до: у заказа 8101 есть история в журнале', hist0.length >= 1, '≥1 записи', String(hist0.length));

    await ok('PATCH', `/api/marketplaces/${s.companyId}/wb/warehouses/11`, ff.token, { ours: false });
    const hidden = await ff.hidden(s.companyId);
    v.expect('сняли отметку: 8101 (без работы) отложен', hidden.includes('8101'), '8101 отложен', `[${hidden.join()}]`);
    await ok('PATCH', `/api/marketplaces/${s.companyId}/wb/warehouses/11`, ff.token, { ours: true });
    const [back] = await ff.q(`SELECT id FROM invoices WHERE company_id = $1 AND external_id = '8101'`, [s.companyId]);
    v.expect('вернули отметку: заказ вернулся той же записью', back && back.id === id8101, id8101, back && back.id);
    const hist1 = await ok('GET', `/api/journal?invoiceId=${id8101}`, ff.token);
    v.expect('история заказа в журнале на месте', hist1.length === hist0.length, `${hist0.length} записи`,
      `${hist1.length} записей`);
  } finally {
    v.done();
    await stop();
  }
})().catch(fail);
