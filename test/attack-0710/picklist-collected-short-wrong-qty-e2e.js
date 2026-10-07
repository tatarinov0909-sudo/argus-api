// Проверка 07.10: лист комплектации собранной поставки (contents → picking,
// печать supply_print.html).
//
// Поставка собрана целиком — лист печатается целиком: «что и из какой ячейки
// взяли» (владелец 06.10). Если позицию закрыли с нехваткой («взяли 3 из 5»),
// лист говорит «взять 5», а в ячейке отбора — 3, и красным «в ячейках только 3».
// То есть лист собранной поставки показывает не то, что взяли.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Лист собранной поставки при позиции, закрытой с нехваткой');
  try {
    const s = await stand(app, { racks: 2 });
    await s.receive([{ qty: 3, cell: s.cells[0] }]);
    const out = await app.ok('POST', '/api/invoices', s.owner, { companyId: s.company, number: 'ОТГ-5', direction: 'out',
      items: [{ sku: 'R-1', name: 'Резинки чёрные', declaredQty: 5 }] });
    const supply = await app.ok('POST', '/api/supplies', s.owner, { invoiceIds: [out.id], destination: 'Иванов' });
    await app.ok('POST', `/api/shipping/assembly/${supply.id}/start`, s.worker, {});
    // На полке только 3 — грузчик взял их и закрыл позицию.
    await app.ok('POST', '/api/shipping', s.worker, { invoiceItemId: out.items[0].id, pickedQty: 3, cellBlockId: s.cells[0].id });
    const data = await app.ok('GET', `/api/supplies/${supply.id}`, s.owner);
    const line = data.picking.find((p) => p.sku === 'R-1');
    const took = line ? line.cells.reduce((n, c) => n + Number(c.take || 0), 0) : null;
    v.expect('поставка собрана', data.supply.status === 'ready', 'ready', data.supply.status);
    v.expect('в листе собранной поставки «взять» — столько, сколько взяли из ячеек (3)', line && line.qty === took,
      `взять ${took}, из ячеек ${took}`,
      line ? `взять ${line.qty}, из ячеек ${took} (${line.cells.map((c) => c.label + ' — ' + c.take).join(', ')}), в ячейках ${line.available}` : 'строки нет');
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
