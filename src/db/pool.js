const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Runs `fn` inside a transaction with the tenant session vars set via
// SET LOCAL, so every query inside `fn` is subject to the RLS policies
// defined in the migrations. This is the only sanctioned way to touch
// tenant tables — never grab a client and run ad-hoc queries elsewhere.
async function withTenantContext({ warehouseId = null, companyId = null }, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_warehouse_id',
      warehouseId ?? '',
    ]);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_company_id',
      companyId ?? '',
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// For queries that must run without any tenant scoping (owner auth,
// registration, cross-tenant admin tasks). Used sparingly and never
// exposed to a request driven by an untrusted role.
async function withoutTenantContext(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = { pool, withTenantContext, withoutTenantContext };
