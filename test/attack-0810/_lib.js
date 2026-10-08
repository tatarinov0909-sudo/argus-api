// Заготовки проверки 08.10.2026: склад с ячейками, продавец с товаром,
// грузчик и вход продавца. Поверх общих заготовок проверки 01.10
// (attack-0110/_lib.js: поддельный WB, закрытая сеть, только тестовая база).
const base = require('../attack-0110/_lib');

// Склад «Ромашка» с учётом в Аргусе (без 1С): «Всего» — ячейки Аргуса.
// Ряд из rack×tier ячеек; продавец «Продавец» с товарами skus.
async function setup(ok, { skus = ['A-1'], racks = 2, tiers = 1, stockSource = 'argus' } = {}) {
  const w = await base.warehouse(ok);
  if (stockSource) await ok('PATCH', '/api/warehouses/me', w.token, { stockSource });
  const companyId = (await ok('POST', '/api/sellers/companies', w.token, { name: 'Продавец' })).id;
  for (const sku of skus) await ok('POST', '/api/products', w.token, { sku, name: `Товар ${sku}`, companyId });
  await ok('POST', '/api/cells/rows', w.token, { configs: [{ rackCount: racks, tierCount: tiers }] });
  const cells = (await ok('GET', '/api/cells/rows', w.token)).flatMap((r) => r.blocks).map((b) => b.id);
  // Положить товар в ячейку (и на склад продавца vw, если указан).
  const put = (cell, sku, qty, vw = null, company = companyId) => w.q(
    `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, virtual_warehouse_id)
     VALUES ($1, $2, $3, $4, $5, $6)`, [cell, w.warehouseId, company, sku, qty, vw]);
  const seller = await w.sellerToken(companyId);
  const worker = await w.worker('Грузчик');
  // Строки остатков продавца так, как их видит продавец (view=seller).
  const stock = async (token = seller) => {
    const r = await ok('GET', '/api/sellers/stock' + (token === seller ? '' : `?view=seller&companyId=${companyId}`), token);
    return Object.fromEntries((r.rows || r).map((x) => [x.sku, x]));
  };
  return { ...w, staff: w.worker, companyId, cells, put, seller, worker, stock };
}

// Собрать поставку целиком: старт сборки и отбор каждой строки из ячейки.
async function pickSupply(ok, w, supplyId, invoiceIds, cell) {
  await ok('POST', `/api/shipping/assembly/${supplyId}/start`, w.worker, {});
  for (const id of invoiceIds) {
    for (const it of (await ok('GET', `/api/invoices/${id}`, w.token)).items) {
      await ok('POST', '/api/shipping', w.worker, { invoiceItemId: it.id, pickedQty: Number(it.declared_qty), cellBlockId: cell, isFinal: true });
    }
  }
}

const to = { recipient: 'Иванов Иван', address: 'Казань, ул. Баумана, 1', phone: '+7 900 000-00-00', deliveryService: 'СДЭК' };

module.exports = { ...base, setup, pickSupply, to };
