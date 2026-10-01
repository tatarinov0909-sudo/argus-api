// Выгрузка остатков владельца (GET /api/sellers/export/1c, файл
// argus-inventory-v1.json) не знает, что склад ведёт учёт в Аргусе.
//
// Экран берёт «где учёт» из анкеты склада (stockSourceOf → loadStock(...,
// { source })), а выгрузка зовёт loadStock(c, companyId) без него — всегда
// как «учёт в 1С». У склада без 1С числа из 1С нет, и выгрузка отказывает
// («Количество товара ещё не получено»), хотя на экране всё есть.
// Ожидаемо: выгрузка совпадает с экраном.
const F = require('./_flow');

(async () => {
  const c = await F.setup({ source: 'argus' });
  const v = F.verdicts('Выгрузка остатков при учёте в Аргусе');
  try {
    const s = await c.w.seller('Продавец', 'key-exp', [{ id: 951, name: 'Ромашка Москва', officeId: 1 }]);
    const sku = 'SKU-key-exp';
    await F.receive(c, s.companyId, sku, 10);
    F.WB.queue['key-exp'] = [F.order(9501, 951)];
    await F.syncWb(c, s.companyId);
    const screen = (await c.ok('GET', `/api/sellers/stock?companyId=${s.companyId}&view=seller`, c.w.token)).rows.find((r) => r.sku === sku);
    console.log('  экран:', F.nums(screen));
    const ready = await c.api('GET', `/api/sellers/export/1c?companyId=${s.companyId}`, c.w.token);
    v.expect('выгрузка готова (числа есть — на экране они есть)', ready.body?.ready === true, 'ready: true',
      JSON.stringify(ready.body?.issues?.map((i) => i.message)));
    const file = await c.api('GET', `/api/sellers/export/1c?companyId=${s.companyId}&download=1`, c.w.token);
    const item = file.body?.items?.find((i) => i.sku === sku);
    v.expect('в файле «на складе» и «доступно» как на экране (10 и 9)', file.status === 200 && item?.onHand === screen?.total && item?.available === screen?.available,
      `${screen?.total} и ${screen?.available}`, file.status === 200 ? `${item?.onHand} и ${item?.available}` : `ответ ${file.status}: ${file.body?.error}`);
    v.done();
  } catch (e) { F.fail(e); } finally { await c.stop(); }
})();
