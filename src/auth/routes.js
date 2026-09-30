const express = require('express');
const service = require('./service');

const { loginLimiter, keyLoginLimiter, registerLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');

router.post('/owner/password', loginLimiter, requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    res.json(await service.changeOwnerPassword(req.auth.ownerId, req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/owner/register', registerLimiter, async (req, res, next) => {
  try {
    const result = await service.registerOwner(req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/owner/login', loginLimiter, async (req, res, next) => {
  try {
    const result = await service.loginOwner(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/staff/login', keyLoginLimiter, async (req, res, next) => {
  try {
    const result = await service.loginStaffKey(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/seller/login', keyLoginLimiter, async (req, res, next) => {
  try {
    const result = await service.loginSellerKey(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
