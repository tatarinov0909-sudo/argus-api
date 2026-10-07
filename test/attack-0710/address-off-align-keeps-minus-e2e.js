// Проверка 07.10: склад без адресного хранения, минус в «Складе» и сверка
// с файлом остатков (ведомость 1С).
//
// Сборка сверх учёта уводит «Склад» в минус — «владелец поправит». Минус
// записывается отдельной строкой, а сверка с файлом видит только строки
// с плюсом: она «чинит» не то, что есть. Файл совпадает с Аргусом (7 шт.),
// а сверка всё равно снимает 3 шт. — и после неё на складе 4.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Сверка с файлом при минусе в «Складе»');
  try {
    const s = await stand(app, { racks: 4, source: 'argus' });
    await s.receive([{ qty: 5, cell: s.cells[0] }]);
    await app.ok('PATCH', '/api/warehouses/me', s.owner, { addressStorage: false });

    // Отгрузка 8 шт. при учёте 5: в «Складе» стало −3 (так задумано).
    const out = await app.ok('POST', '/api/invoices', s.owner, { companyId: s.company, number: 'ОТГ-1', direction: 'out',
      items: [{ sku: 'R-1', name: 'Резинки чёрные', declaredQty: 8 }] });
    await app.ok('POST', '/api/shipping', s.worker, { invoiceItemId: out.items[0].id, pickedQty: 8, cellBlockId: s.cells[0].id });
    // Пришло ещё 10 шт.
    await s.receive([{ qty: 10, cell: s.cells[1] }]);
    const net = async () => Number((await s.q(
      `SELECT COALESCE(SUM(qty),0) AS n FROM cell_stock WHERE company_id = $1 AND sku = 'R-1' AND quality = 'good'`,
      [s.company]))[0].n);
    const before = await net();
    const sellerBefore = (await app.ok('GET', '/api/sellers/stock', s.seller)).rows.find((r) => r.sku === 'R-1');

    // Владелец сверяет по ведомости: в ней ровно столько же, сколько у
    // Аргуса, — 7 шт. на полках и 8 шт. собранных, но ещё не уехавших
    // (1С спишет их при отгрузке), всего 15.
    const file = before + 8;
    const grid = [
      [null, 'Ведомость по товарам на складах'],
      [null, 'Номенклатура.Код', 'Приход', 'Расход', 'Конечный остаток'],
      [null, 'Номенклатура, Базовая единица измерения'],
      [null, 'R-1', null, null, file], [null, 'Резинки чёрные, шт', null, null, file],
    ];
    const res = await app.ok('POST', '/api/cells/stock-align', s.owner, { companyId: s.company, grid, apply: true });
    const after = await net();
    const seller = (await app.ok('GET', '/api/sellers/stock', s.seller)).rows.find((r) => r.sku === 'R-1');
    v.expect(`до сверки по учёту ${before} шт. (5 − 8 + 10)`, before === 7, '7', before);
    v.expect('файл совпадает с Аргусом — сверка ничего не меняет', after === before,
      `${before} шт. на полках, у продавца «Всего» ${sellerBefore && sellerBefore.total}`,
      `${after} шт.; отчёт сверки: ${res.lines.map((l) => l.note || l.change).join(' | ')}; у продавца «Всего» ${seller && seller.total}`);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
