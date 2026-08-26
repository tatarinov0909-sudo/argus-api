// Кладовщик — rule layer only. "решают правила, ИИ только объясняет":
// this module answers questions with plain DB queries; no LLM here.
// Natural-language explanation is a thin layer on top, added separately
// once there's an API key to call.

async function findProducts(client, warehouseId, query) {
  const products = await client.query(
    `SELECT sku, name, category, weight_g
     FROM products
     WHERE warehouse_id = $1 AND active AND (sku ILIKE $2 OR name ILIKE $2)
     ORDER BY name LIMIT 20`,
    [warehouseId, `%${query}%`],
  );

  const results = [];
  for (const p of products.rows) {
    const stock = await client.query(
      `SELECT cs.qty, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       FROM cell_stock cs
       JOIN cell_blocks cb ON cb.id = cs.cell_block_id
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       WHERE cs.warehouse_id = $1 AND cs.sku = $2
       ORDER BY wr.row_num`,
      [warehouseId, p.sku],
    );
    results.push({
      sku: p.sku,
      name: p.name,
      category: p.category,
      weightG: p.weight_g,
      totalQty: stock.rows.reduce((sum, r) => sum + Number(r.qty), 0),
      locations: stock.rows.map((r) => ({
        row: r.row_num,
        rackFrom: r.rack_start, rackTo: r.rack_end,
        tierFrom: r.tier_start, tierTo: r.tier_end,
        qty: Number(r.qty),
      })),
    });
  }
  return results;
}

function formatBlockLabel(rowNum, block) {
  const rackPart = block.rack_start === block.rack_end ? block.rack_start : `${block.rack_start}–${block.rack_end}`;
  const tierPart = block.tier_start === block.tier_end ? block.tier_start : `${block.tier_start}–${block.tier_end}`;
  return `${rowNum}.${rackPart}.${tierPart}`;
}

// Подсказка ячейки при приёмке — чистое правило, без ИИ: сначала предложить
// ячейку, где этот SKU уже лежит (не размазывать один товар по складу),
// потом — просто свободную. Про габариты (влезет/не влезет) правила пока
// нет — у товаров почти всегда пустые размеры (см. argus_1c_sync_status),
// добавится само, когда данные появятся.
async function suggestCells(client, warehouseId, sku, limit = 3) {
  const sameSku = await client.query(
    `SELECT DISTINCT cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
     FROM cell_stock cs
     JOIN cell_blocks cb ON cb.id = cs.cell_block_id
     JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     WHERE cs.warehouse_id = $1 AND cs.sku = $2
     ORDER BY wr.row_num, cb.rack_start, cb.tier_start
     LIMIT $3`,
    [warehouseId, sku, limit],
  );

  const options = sameSku.rows.map((b) => ({
    blockId: b.id,
    label: formatBlockLabel(b.row_num, b),
    reason: 'same_sku',
  }));

  if (options.length < limit) {
    const empty = await client.query(
      `SELECT cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       FROM cell_blocks cb
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       WHERE cb.warehouse_id = $1 AND cb.state = 'empty'
       ORDER BY wr.row_num, cb.rack_start, cb.tier_start
       LIMIT $2`,
      [warehouseId, limit - options.length],
    );
    for (const b of empty.rows) {
      options.push({ blockId: b.id, label: formatBlockLabel(b.row_num, b), reason: 'empty' });
    }
  }

  return options;
}

module.exports = { findProducts, suggestCells };
