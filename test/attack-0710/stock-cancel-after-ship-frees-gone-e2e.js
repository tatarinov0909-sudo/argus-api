// Проверка 07.10: остатки продавца, отмена заказа WB после отгрузки.
//
// Учёт в 1С. Поставка с двумя посылками уехала на WB, 1С ещё не провела
// отгрузку (числит 10), на полке 8. Покупатель отменил один заказ, когда
// посылка уже уехала, — она вернётся складу возвратом через дни. Пока она
// в дороге, её продать нельзя. А «Доступно» сразу вырастает до 9: продавец
// выставит на WB 9 шт., хотя на полке 8.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Отмена заказа WB после отгрузки (учёт в 1С)');
  try {
    const s = await stand(app, { racks: 1, source: '1c' });
    await s.q(`UPDATE products SET stock_qty_1c = 10, stock_at = now() WHERE company_id = $1 AND sku = 'R-1'`, [s.company]);
    await s.q(`INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1, $2, $3, 'R-1', 10)`,
      [s.cells[0].id, s.warehouseId, s.company]);
    // Сверка с файлом остатков была до отгрузки: ячейки и 1С совпали.
    await s.q(`INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, details)
      VALUES ($1, $2, 'document_align', 'R-1', 10, '{}')`, [s.warehouseId, s.company]);
    const order = async (n) => {
      const inv = await app.ok('POST', '/api/invoices', s.owner, { companyId: s.company, number: `WB-${n}`, direction: 'out',
        items: [{ sku: 'R-1', name: 'Резинки чёрные', declaredQty: 1 }] });
      await s.q(`UPDATE invoices SET source = 'wb', external_id = $2, mp_supplier_status = 'new' WHERE id = $1`, [inv.id, String(n)]);
      await s.q(`UPDATE invoice_items SET mp_rid = $2 WHERE invoice_id = $1`, [inv.id, `rid-${n}`]);
      return inv;
    };
    const a = await order(71001);
    const b = await order(71002);
    const supply = await app.ok('POST', '/api/supplies', s.owner, { invoiceIds: [a.id, b.id], marketplace: 'wb', destination: 'СЦ' });
    await app.ok('POST', `/api/shipping/assembly/${supply.id}/start`, s.worker, {});
    for (const inv of [a, b]) {
      await app.ok('POST', '/api/shipping', s.worker, { invoiceItemId: inv.items[0].id, pickedQty: 1, cellBlockId: s.cells[0].id });
    }
    await app.ok('POST', `/api/supplies/${supply.id}/ship`, s.worker, {});
    const row = async () => (await app.ok('GET', '/api/sellers/stock', s.seller)).rows.find((r) => r.sku === 'R-1');
    const shelf = async () => Number((await s.q(`SELECT COALESCE(SUM(qty),0) AS n FROM cell_stock WHERE company_id = $1 AND sku = 'R-1'`, [s.company]))[0].n);
    const before = await row();
    v.expect('поставка уехала: «В пути» 2, «Доступно» 8 — как на полке', before.inTransit === 2 && before.available === 8,
      'в пути 2, доступно 8', `в пути ${before.inTransit}, доступно ${before.available}`);

    // Обмен статусов WB: заказ A отменён уже после отгрузки (так его
    // закрывает src/marketplaces/statuses.js для уехавшей поставки).
    await s.q(`UPDATE invoices SET mp_closed_at = now(), mp_close_reason = 'canceled' WHERE id = $1`, [a.id]);
    const after = await row();
    const onShelf = await shelf();
    v.expect('посылка с отменённым заказом ещё едет назад — «Доступно» не больше, чем на полке',
      after.available <= onShelf, `не больше ${onShelf}`,
      `«Всего» ${after.total}, «В пути» ${after.inTransit}, «Доступно» ${after.available}, на полке ${onShelf}`);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
