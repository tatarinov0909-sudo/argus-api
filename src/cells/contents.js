// Что лежит в ячейке — полностью (владелец 27.09.2026): товар, продавец,
// артикул, штрихкод, артикул WB, количество, годное или брак, когда положили.
//
// Карта склада держит в памяти только артикул и количество — на все ячейки
// склада сразу (их тысячи); подробности — по нажатию, одной ячейкой.
// Смотрят и кабинет склада («Склад и ячейки»), и грузчик — везде, где у
// него видна ячейка.
const { HttpError } = require('../middleware/errorHandler');
const { formatBlockLabel } = require('./label');
const { productCodesJoin } = require('../products/codes');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUALITY = { good: 'годный', defective: 'брак', packaging_defect: 'брак упаковки' };

async function blockContents(client, warehouseId, blockId) {
  if (!UUID.test(String(blockId || ''))) throw new HttpError(404, 'Ячейка не найдена');
  const block = (await client.query(
    `SELECT cb.id, cb.state, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cb.warehouse_id = $1 AND cb.id = $2`,
    [warehouseId, blockId],
  )).rows[0];
  if (!block) throw new HttpError(404, 'Ячейка не найдена');
  // Одна строка — товар одного продавца в одном состоянии: три приёмки
  // одного товара — это одна строка «15 шт.», а не три.
  const items = (await client.query(
    `SELECT cs.company_id, c.name AS seller, cs.sku, cs.quality,
            SUM(cs.qty)::numeric AS qty,
            MIN(cs.placed_at) AS first_placed_at, MAX(cs.placed_at) AS placed_at,
            COALESCE(MAX(p.name), cs.sku) AS name,
            MAX(codes.barcode) AS barcode, MAX(codes.wb_article) AS wb_article
       FROM cell_stock cs
       LEFT JOIN companies c ON c.id = cs.company_id
       LEFT JOIN products p ON p.warehouse_id = cs.warehouse_id AND p.company_id = cs.company_id AND p.sku = cs.sku
       ${productCodesJoin('cs.warehouse_id', 'cs.company_id', 'cs.sku')}
      WHERE cs.warehouse_id = $1 AND cs.cell_block_id = $2 AND cs.qty > 0
      GROUP BY cs.company_id, c.name, cs.sku, cs.quality
      ORDER BY name, cs.sku, cs.quality`,
    [warehouseId, block.id],
  )).rows;
  return {
    cellBlockId: block.id,
    label: formatBlockLabel(block.row_num, block),
    state: block.state,
    totalUnits: items.reduce((sum, i) => sum + Number(i.qty), 0),
    items: items.map((i) => ({
      companyId: i.company_id,
      seller: i.seller || null,
      sku: i.sku,
      name: i.name,
      barcode: i.barcode || null,
      wbArticle: i.wb_article || null,
      quality: i.quality,
      qualityName: QUALITY[i.quality] || i.quality,
      qty: Number(i.qty),
      placedAt: i.placed_at,
      firstPlacedAt: i.first_placed_at,
    })),
  };
}

module.exports = { blockContents };
