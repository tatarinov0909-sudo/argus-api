// «На WB» пусто у товара, чьи первые заказы пришли несопоставленными.
//
// Сколько выставлено на WB, WB отдаёт по размеру (chrtId). Чей это товар,
// сервер узнаёт по заказам: размер → самый частый артикул в заказах этого
// размера (src/sellers/routes.js, GET /wb-warehouses, sizes). Заказы, пришедшие
// до сопоставления товара, лежат с артикулом WB вместо нашего; закрытые WB
// так и остаются (сопоставление чинит только открытые). Если таких старых
// заказов больше, размер «принадлежит» артикулу WB — и у настоящего товара
// «На WB» пусто, а предупреждение «на WB больше, чем доступно» не срабатывает.
const F = require('./_flow');
const wb = require('../../src/marketplaces/wb');

(async () => {
  const c = await F.setup({ source: 'argus' });
  const v = F.verdicts('«На WB» после позднего сопоставления');
  try {
    const key = 'key-late';
    const s = await c.w.seller('Продавец', key, [{ id: 961, name: 'Ромашка Москва', officeId: 1 }]);
    const sku = `SKU-${key}`;
    // Сопоставления ещё нет: новый продавец, матрицу не завели.
    await c.w.q('DELETE FROM product_marketplace_skus WHERE company_id = $1', [s.companyId]);
    F.WB.queue[key] = [F.order(9601, 961), F.order(9602, 961), F.order(9603, 961)];
    await F.syncWb(c, s.companyId);
    F.WB.queue[key] = [];
    for (const id of ['9601', '9602', '9603']) F.WB.statuses[id] = { supplierStatus: 'cancel', wbStatus: 'canceled_by_client' };
    await F.syncWb(c, s.companyId);
    // Матрицу завели — дальше заказы приходят сопоставленными.
    await c.w.q(`INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article, mp_barcode)
                 VALUES ($1, $2, $3, 'wb', '111', 'ART-1', '2000000000011')`, [c.w.warehouseId, s.companyId, sku]);
    F.WB.queue[key] = [F.order(9604, 961), F.order(9605, 961)];
    // WB: на складе 961 выставлено 5 штук этого размера.
    wb.stocks = async (_, __, chrts) => chrts.map((ch) => ({ chrtId: ch, amount: 5 }));
    await c.w.q('UPDATE marketplace_credentials SET wb_stocks_at = NULL WHERE company_id = $1', [s.companyId]);
    await F.syncWb(c, s.companyId);
    const token = await c.w.sellerToken(s.companyId);
    const info = await c.ok('GET', '/api/sellers/wb-warehouses', token);
    console.log('  «выставлено на WB» по товарам:', JSON.stringify(info.stock));
    const amount = info.stock?.[sku]?.['961'];
    v.expect('у товара «На WB» 5 (склад «Ромашка Москва»)', amount === 5, 5, amount);
    v.done();
  } catch (e) { F.fail(e); } finally { await c.stop(); }
})();
