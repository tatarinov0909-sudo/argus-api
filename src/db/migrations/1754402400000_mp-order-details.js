// Что менеджер должен видеть о заказе площадки: когда покупатель его
// оформил, куда он едет и за сколько продан. Площадка присылала это в
// каждом задании, а мы выбрасывали: в списке у менеджера было только
// время, когда Аргус забрал заказ, — у первых пятисот оно одно на всех
// (владелец 22.09: «видит пустые заказы, а должен знать, когда пришли»).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS mp_created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS mp_offices TEXT[],
      ADD COLUMN IF NOT EXISTS mp_sale_price_kopecks BIGINT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices
      DROP COLUMN IF EXISTS mp_created_at,
      DROP COLUMN IF EXISTS mp_offices,
      DROP COLUMN IF EXISTS mp_sale_price_kopecks;
  `);
};
