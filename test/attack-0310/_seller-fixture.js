// Подделка ответов API для кабинета продавца со складом «Озон»: один товар,
// как на стенде у «Авезов ИП (тест)» — «Гранола шоколадная 400 г»: всего 75,
// заказано 2 (заказ WB вне поставки), в сборке 1, доступно 72;
// по складам — «Озон» 3, «Остальной товар» 72.
const company = { id: '11111111-1111-1111-1111-111111111111', name: 'Авезов ИП (тест)' };
const ozon = { id: '22222222-2222-2222-2222-222222222222', name: 'Озон', marketplace: 'ozon', marketplaceName: 'Озон',
  keepSeparate: true, defectSeparate: false, archivedAt: null, createdAt: '2026-10-02T19:24:06Z' };
const row = {
  sku: 'R-1', name: 'Гранола шоколадная 400 г', barcode: '4610000087109', total: 75, totalKnown: true,
  ordered: 2, inAssembly: 1, inTransit: 2, available: 72, defective: 0, orderedOrders: 1, assemblyOrders: 1,
  updatedAt: '2026-10-02T16:23:31Z',
  warehouses: [
    { id: ozon.id, name: 'Озон', onHand: 3, inAssembly: 0, available: 3, defect: 0 },
    { id: null, name: 'Остальной товар', onHand: 72, inAssembly: 1, available: 71, defect: 0 },
  ],
};
const summary = { productCount: 1, total: 75, ordered: 2, inAssembly: 1, inTransit: 2, available: 72, defect: 0,
  shortageCount: 0, unknownCount: 0, unknownNames: [], updatedAt: '2026-10-02T16:23:31Z' };

function apiData(p) {
  if (p === '/api/sellers/companies') return [company];
  if (p === '/api/sellers/profile') return { ...company, warehouseId: 'wh', warehouseName: 'Восход', timezone: 'Europe/Moscow' };
  if (p === '/api/sellers/catalog') return { products: [{ sku: 'R-1', category: 'Без категории', cards: [{ nmId: '300015103', vendorCode: 'av-111', photoUrl: null }], wbBarcodes: ['4610000087109'] }] };
  if (p === '/api/sellers/stock') return { rows: [row], summary };
  if (p === '/api/sellers/wb-warehouses') return { ffName: 'Восход', connected: false, active: false, unknownOrders: 0, refreshedAt: null, warehouses: [], stock: {} };
  if (p === '/api/sellers/history') return { events: [], hasMore: false, nextCursor: null };
  if (p === '/api/sellers/defects') return { balances: [], moves: [], decisions: [], hasMore: false };
  if (p.startsWith('/api/sellers/')) return { rows: [], hasMore: false };
  if (p === '/api/vwarehouses') return { main: { id: null, name: 'Остальной товар' }, warehouses: [ozon], rights: { decide: true },
    wbChoices: [{ id: null, name: 'Остальной товар' }] };
  if (p.startsWith('/api/vwarehouses/')) return [];
  return undefined;
}

module.exports = { company, ozon, row, summary, apiData };
