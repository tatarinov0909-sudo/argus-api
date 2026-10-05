// Находка: Excel для добавления в виртуальный склад не узнаёт товар, который
// Аргус знает. Сверка ищет только точный «артикул Аргуса» и один основной
// штрихкод карточки. Тот же файл в «Приходе из Excel» находится: там артикул
// без учёта регистра, артикул продавца WB и штрихкод WB тоже считаются.
// Каталог клиента сам не различает «pb000021144» и «PB000021144» (второй
// такой товар завести нельзя), значит угадывания здесь нет.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Excel виртуального склада: сопоставление кодов');
  try {
    const s = await stand(app, { skus: [['PB000021144', 'Резинки чёрные']], racks: 2 });
    await s.receive([{ qty: 5, cell: s.cells[0] }]);
    // Карточка WB этого товара: артикул продавца и штрихкод WB (как у продавцов с подключённым WB).
    await s.q(`INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article, mp_barcode)
               VALUES ($1, $2, 'PB000021144', 'wb', '300015103', 'av-111', '4610000087109')`, [s.warehouseId, s.company]);
    const vw = await app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'other' });
    const preview = (item) => app.ok('POST', '/api/vwarehouses/transfers/preview', s.owner,
      { companyId: s.company, toVw: vw.id, items: [{ fromVw: null, qty: 1, ...item }] });
    for (const [label, item] of [
      ['артикул Аргуса в другом регистре «pb000021144»', { sku: 'pb000021144' }],
      ['штрихкод WB «4610000087109»', { barcode: '4610000087109' }],
      ['артикул продавца WB «av-111»', { sku: 'av-111' }],
    ]) {
      const r = await preview(item);
      v.expect(`${label} → товар PB000021144`, r.canCommit && r.items[0].sku === 'PB000021144',
        'строка сопоставлена с «Резинки чёрные»', JSON.stringify(r.errors.map((e) => e.message)));
    }
  } catch (err) { fail(err); } finally { await app.stop(); v.done(); }
})();
