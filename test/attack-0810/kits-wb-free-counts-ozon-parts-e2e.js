// Находка: «Свободно для WB» у набора считает части, лежащие на складе
// продавца «Озон». В том же правиле для обычного товара склад Озон не
// считается: «товар склада Озон на WB не продаётся» (seller-cabinet.js,
// wbAvailable; sellers/wbListing.js, freeForWb — «со складов, с которых
// собирают на WB»). У набора «+ собрать N» берётся из «Доступно» частей по
// всему товару продавца — и тревога «На WB больше, чем свободно» молчит,
// хотя собрать набор для WB не из чего.
const { startApp, verdicts, fail, setup } = require('./_lib');

async function kitWarehouse(ok, partsOnOzon) {
  const w = await setup(ok, { skus: ['KIT', 'PART'] });
  const ozon = await ok('POST', '/api/vwarehouses', w.token, { companyId: w.companyId, name: 'Озон', marketplace: 'ozon' });
  await w.put(w.cells[0], 'PART', 10, partsOnOzon ? ozon.id : null);
  await ok('PUT', `/api/kits/company/${w.companyId}/kit`, w.token, { kitSku: 'KIT', components: [{ sku: 'PART', qty: 2 }] });
  // Набор выставлен на нашем складе WB: 5 шт. Размер WB ↔ набор — по заказу WB.
  await w.q(`INSERT INTO seller_wb_warehouses (warehouse_id, company_id, mp_warehouse_id, name, ours, decided_by)
             VALUES ($1, $2, 'W1', 'Ромашка', true, 'owner')`, [w.warehouseId, w.companyId]);
  const inv = await ok('POST', '/api/invoices', w.token, { companyId: w.companyId, number: 'WB-1', direction: 'out',
    items: [{ sku: 'KIT', name: 'Набор', declaredQty: 1 }] });
  await w.q(`UPDATE invoices SET source = 'wb', external_id = '9001', mp_closed_at = now(), mp_close_reason = 'canceled' WHERE id = $1`, [inv.id]);
  await w.q(`UPDATE invoice_items SET mp_chrt_id = 'C1' WHERE invoice_id = $1`, [inv.id]);
  await w.q(`INSERT INTO wb_stock_levels (warehouse_id, company_id, mp_warehouse_id, chrt_id, amount) VALUES ($1, $2, 'W1', 'C1', 5)`,
    [w.warehouseId, w.companyId]);
  const rows = await ok('GET', `/api/sellers/stock?companyId=${w.companyId}`, w.token);
  return { kit: rows.find((r) => r.sku === 'KIT'), part: rows.find((r) => r.sku === 'PART') };
}

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Набор: «свободно для WB» из частей со склада «Озон»');
  try {
    const main = await kitWarehouse(ok, false);
    v.expect('для сравнения: части на «Остальном товаре» — набор можно собрать (5), тревоги нет',
      main.kit && main.kit.kitBuildable === 5 && main.kit.wbOver === 0, 'собрать 5, wbOver 0',
      JSON.stringify(main.kit && { kitBuildable: main.kit.kitBuildable, wbListed: main.kit.wbListed, wbOver: main.kit.wbOver }));
    const ozon = await kitWarehouse(ok, true);
    v.expect('части только на складе «Озон»: для WB собрать не из чего — «На WB 5» больше свободного, тревога есть',
      ozon.kit && ozon.kit.wbOver === 5, 'wbOver 5 (свободно для WB 0)',
      JSON.stringify(ozon.kit && { kitBuildable: ozon.kit.kitBuildable, wbListed: ozon.kit.wbListed, wbOver: ozon.kit.wbOver,
        partByWarehouse: ozon.part && ozon.part.byWarehouse && ozon.part.byWarehouse.map((x) => `${x.name}: ${x.available}`) }));
  } catch (e) { fail(e); } finally { v.done(); await stop(); }
})();
