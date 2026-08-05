// Turns req.auth (the JWT payload) into the { warehouseId, companyId }
// pair passed to withTenantContext(). This is deliberately its own
// function, not inline destructuring, because getting it wrong is
// exactly the kind of tenant-isolation bug this project has already
// shipped once (the old "one seller key opens several companies" bug —
// see PROJECT.md section 6).
//
// A seller's JWT does carry warehouseId (seller_keys.warehouse_id is
// needed to look the key up at login), but a seller request must NEVER
// set app.current_warehouse_id — RLS policies on invoices/invoice_items/
// receiving_records/dropzone_items match on "warehouse_id = ... OR
// company_id = ...", so leaking the warehouse scope in would let a
// seller see every company's rows in their warehouse, not just their own.
function tenantContextFromAuth(auth) {
  if (!auth) return {};
  if (auth.role === 'seller') {
    return { companyId: auth.companyId };
  }
  return { warehouseId: auth.warehouseId };
}

module.exports = { tenantContextFromAuth };
