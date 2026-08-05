/* eslint-disable camelcase */

exports.shorthands = undefined;

// Same bug class as find_staff_key_for_login / find_seller_key_for_login:
// warehouses is RLS-protected by its own id, but owner login needs to find
// that id by owner_id BEFORE any tenant context exists — a plain SELECT
// under argus_app sees zero rows and reads as "no warehouse" for every
// returning owner. owner_id -> warehouse lookup is safe to do unscoped
// here specifically because the caller (loginOwner) has already verified
// the password against this exact owner_id before calling this.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION find_owner_warehouse(p_owner_id UUID)
    RETURNS TABLE(id UUID, name TEXT, city TEXT, warehouse_code TEXT)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT id, name, city, warehouse_code FROM warehouses
      WHERE owner_id = p_owner_id ORDER BY created_at ASC LIMIT 1;
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS find_owner_warehouse(UUID);`);
};
