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

module.exports = { findProducts };
