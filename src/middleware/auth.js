const jwt = require('jsonwebtoken');

// Verifies the JWT and attaches req.auth = { role, warehouseId, ownerId, companyId, staffKeyId, sellerKeyId }.
// Does NOT set RLS vars itself — route handlers pass req.auth into withTenantContext()
// when they touch the DB, so the scoping decision always sits next to the query.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Отсутствует токен авторизации' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.auth = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недействительный или истёкший токен' });
  }
}

// Restricts a route to one or more roles: 'owner' | 'worker' | 'seller'
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
