/* eslint-disable camelcase */

exports.shorthands = undefined;

// staff_keys and seller_keys are RLS-protected by warehouse_id/company_id —
// but logging in is exactly the moment we don't know that scope yet (the
// key IS how we find out). A plain SELECT from argus_app sees zero rows,
// which read as "key not found" even for a valid key.
//
// key_code is globally UNIQUE (not per-tenant), so an unscoped lookup by
// exact key_code cannot leak cross-tenant data — it returns at most the one
// row that key belongs to. SECURITY DEFINER functions give argus_app a
// narrow, fixed-query way to do exactly that lookup and nothing else,
// instead of granting BYPASSRLS (which would remove RLS everywhere).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION find_staff_key_for_login(p_key_code TEXT)
    RETURNS TABLE(id UUID, warehouse_id UUID, name TEXT, active BOOLEAN)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT id, warehouse_id, name, active FROM staff_keys WHERE key_code = p_key_code;
    $$;

    CREATE FUNCTION find_seller_key_for_login(p_key_code TEXT)
    RETURNS TABLE(id UUID, company_id UUID, warehouse_id UUID, active BOOLEAN, company_name TEXT)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT sk.id, sk.company_id, sk.warehouse_id, sk.active, c.name AS company_name
      FROM seller_keys sk JOIN companies c ON c.id = sk.company_id
      WHERE sk.key_code = p_key_code;
    $$;

    -- EXECUTE is granted in setup-app-role.sql, not here — that script
    -- assumes migrations already ran (it grants on tables these functions
    -- depend on too), and the argus_app role may not exist yet the first
    -- time this migration runs on a fresh database.
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS find_staff_key_for_login(TEXT);
    DROP FUNCTION IF EXISTS find_seller_key_for_login(TEXT);
  `);
};
