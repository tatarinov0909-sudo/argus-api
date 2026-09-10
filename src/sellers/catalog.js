// Marketplace identifiers are distinct from the internal warehouse SKU.
function combineCatalog(rows) {
  const products = new Map();
  for (const r of rows) {
    if (!products.has(r.sku)) products.set(r.sku, { sku: r.sku, category: r.category || 'Без категории', cards: [] });
    const product = products.get(r.sku);
    if (!r.nm_id || !/^\d+$/.test(r.nm_id)) continue;
    if (product.cards.some(c => c.nmId === r.nm_id && c.vendorCode === (r.article || null))) continue;
    product.cards.push({ nmId: r.nm_id, vendorCode: r.article || null, photoUrl: r.photo_url || null });
  }
  return [...products.values()];
}
module.exports = { combineCatalog };
