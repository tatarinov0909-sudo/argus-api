// Проверка 07.10: разобрать поставку физлицу.
//
// «Новая поставка» физлицу одним шагом заводит заказ на отгрузку и поставку.
// Менеджер передумал и нажал «Разобрать» — поставки нет, а заказ остаётся
// навсегда: у продавца товар висит «Заказано» и не «Доступно», грузчик видит
// «отгрузку из 1С», а удалить такой заказ в Аргусе нечем.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Разобранная поставка физлицу');
  try {
    const s = await stand(app, { racks: 1, source: 'argus' });
    await s.receive([{ qty: 10, cell: s.cells[0] }]);
    const row = async () => (await app.ok('GET', '/api/sellers/stock', s.seller)).rows.find((r) => r.sku === 'R-1');
    const before = await row();
    const supply = await app.ok('POST', '/api/supplies/direct', s.owner, { companyId: s.company, destination: 'Иванов, Казань',
      items: [{ sku: 'R-1', qty: 3 }] });
    await app.ok('DELETE', `/api/supplies/${supply.id}`, s.owner);
    const after = await row();
    v.expect('после «Разобрать» у продавца ничего не «Заказано»', after.ordered === 0, '0', after.ordered);
    v.expect('«Доступно» вернулось к прежнему', after.available === before.available,
      String(before.available), String(after.available));
    const loose = (await app.ok('GET', '/api/invoices', s.worker))
      .filter((i) => i.direction === 'out' && !i.supply_id && i.status !== 'shipped');
    v.expect('грузчику нечего отгружать по разобранной поставке', loose.length === 0, 'нет заказов',
      loose.map((i) => `${i.number} (${i.source})`).join(', '));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
