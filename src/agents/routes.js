const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const kladovshchik = require('./kladovshchik');

const router = express.Router();

// Owner/staff only — a seller has no warehouseId in their token (RLS scopes
// them by companyId instead, see tenantContext.js), and this tool is about
// physical cell locations, which a seller has no reason to query anyway.
router.get('/kladovshchik/find', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const q = req.query.q?.trim();
    if (!q) throw new HttpError(400, 'Укажите ?q= — что искать');

    const { warehouseId } = req.auth;
    const results = await withTenantContext({ warehouseId }, (client) => (
      kladovshchik.findProducts(client, warehouseId, q)
    ));
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
