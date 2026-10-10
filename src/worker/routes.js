const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { capabilities } = require('./commands');
const qr = require('./cellQr');

const router = express.Router();
router.get('/capabilities', requireAuth, requireRole('worker', 'owner', 'manager'), (_req, res) => res.json(capabilities));
router.get('/cells/:id/qr', requireAuth, requireRole('worker', 'owner', 'manager'), async (req, res, next) => {
  try {
    res.json(await withTenantContext({ warehouseId: req.auth.warehouseId }, (c) => qr.cell(c, req.auth.warehouseId, req.params.id)));
  } catch (err) { next(err); }
});
router.post('/cells/resolve', requireAuth, requireRole('worker', 'owner', 'manager'), async (req, res, next) => {
  try {
    res.json(await withTenantContext({ warehouseId: req.auth.warehouseId }, (c) => qr.verify(c, req.auth.warehouseId, req.body?.qr)));
  } catch (err) { next(err); }
});
module.exports = router;
