// Marketplace identifiers belong to the seller's catalogue, not the warehouse.
// Keep all existing rows; several sellers may use identical article/barcode keys.
exports.up = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_mp_sku_unique;
    CREATE UNIQUE INDEX idx_mp_sku_unique ON product_marketplace_skus
      (warehouse_id, company_id, marketplace, COALESCE(mp_sku,''),
       COALESCE(mp_article,''), COALESCE(mp_barcode,''));`);
};

// Reinstating warehouse-wide uniqueness could discard another seller's mapping.
exports.down = false;
