/* eslint-disable camelcase */

exports.shorthands = undefined;

// Found via smoke test: GET /api/invoices INNER JOINs companies (for the
// display name) and RLS applies independently to each side of a join — a
// seller session has no app.current_warehouse_id, so the old
// warehouse_id-only policy on companies hid the seller's own company row
// and silently zeroed out every invoice they should have seen. A seller
// needs read access to exactly their own company row, nothing else.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER POLICY tenant_isolation ON companies USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER POLICY tenant_isolation ON companies USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
  `);
};
