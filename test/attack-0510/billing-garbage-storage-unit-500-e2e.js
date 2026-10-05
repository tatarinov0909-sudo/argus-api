// Находка: мусор в поле «хранение за» прайса клиента даёт «внутреннюю ошибку
// сервера» (500) вместо понятного отказа (400). Проверка единицы хранения
// смотрит в обычный объект JS, и слово «constructor» проходит её.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Прайс клиента: мусорная единица хранения');
  try {
    const s = await stand(app, { racks: 1 });
    for (const unit of ['constructor', 'toString', '__proto__']) {
      const r = await app.api('PUT', '/api/warehouses/billing/tariff', s.owner, { companyId: s.company, effectiveFrom: '2026-09-01',
        prices: { storage: '1', receiving: '1', picking: '1', returns: '1' }, storageUnit: unit });
      v.expect(`storageUnit «${unit}» — понятный отказ 400`, r.status === 400, '400 «Хранение берём за ячейку или за штуку»',
        `${r.status} ${JSON.stringify(r.body)}`);
    }
  } catch (err) { fail(err); } finally { await app.stop(); v.done(); }
})();
