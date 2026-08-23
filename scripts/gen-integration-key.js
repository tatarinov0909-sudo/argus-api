// One-off script: generate a real integration key for a warehouse, using the
// same code path as POST /api/sync/keys. Run on the server with the app's own
// .env loaded — not exposed as an HTTP endpoint change.
//
// Takes the warehouse UUID directly (not warehouse_code) because looking up
// warehouse_code would need its own RLS-bypassing SECURITY DEFINER function —
// argus_app can't see the warehouses table until tenant context is already
// set, and the whole point here is we don't have that yet. Get the UUID via
// `sudo -u postgres psql -d argus -c "SELECT id FROM warehouses WHERE
// warehouse_code = '...'"` first (postgres bypasses RLS as table owner).
require('dotenv').config();
const { withTenantContext, pool } = require('../src/db/pool');
const service = require('../src/sync/service');

const warehouseId = process.argv[2];
const warehouseCode = process.argv[3];
if (!warehouseId || !warehouseCode) {
  console.error('Usage: node gen-integration-key.js <warehouse_uuid> <warehouse_code>');
  process.exit(1);
}

(async () => {
  const key = await withTenantContext({ warehouseId }, async (client) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const keyCode = service.generateKeyCode(warehouseCode);
      try {
        const r = await client.query(
          `INSERT INTO integration_keys (warehouse_id, key_code, label)
           VALUES ($1, $2, $3) RETURNING id, key_code, label`,
          [warehouseId, keyCode, '1C:УТ 10.3'],
        );
        return r.rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }
    throw new Error('Could not generate a unique key code');
  });

  console.log(JSON.stringify(key, null, 2));
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
