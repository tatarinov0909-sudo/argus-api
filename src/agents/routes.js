const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { tenantContextFromAuth } = require('../auth/tenantContext');
const kladovshchik = require('./kladovshchik');

const router = express.Router();

router.get('/kladovshchik/find', requireAuth, async (req, res, next) => {
  try {
    const q = req.query.q?.trim();
    if (!q) throw new HttpError(400, 'Укажите ?q= — что искать');

    const ctx = tenantContextFromAuth(req.auth);
    const results = await withTenantContext(ctx, (client) => (
      kladovshchik.findProducts(client, ctx.warehouseId, q)
    ));
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
