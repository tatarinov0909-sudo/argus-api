const { withoutTenantContext } = require('../db/pool');

async function isLeadAdmin(ownerId) {
  if (!ownerId) return false;
  return withoutTenantContext(async c => (await c.query(
    'SELECT 1 FROM platform_administrators WHERE owner_id=$1 AND active', [ownerId],
  )).rowCount > 0);
}

async function requireLeadAdmin(req, res, next) {
  try {
    if (req.auth?.role !== 'owner' || !await isLeadAdmin(req.auth.ownerId)) {
      return res.status(403).json({ error: 'Раздел доступен только администратору Аргуса' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  } catch (err) { next(err); }
}

async function withLeadAdmin(ownerId, fn) {
  return withoutTenantContext(async c => {
    await c.query('BEGIN');
    try {
      await c.query("SELECT set_config('app.platform_owner_id',$1,true)", [ownerId]);
      const value = await fn(c);
      await c.query('COMMIT');
      return value;
    } catch (err) { await c.query('ROLLBACK'); throw err; }
  });
}

module.exports = { isLeadAdmin, requireLeadAdmin, withLeadAdmin };
