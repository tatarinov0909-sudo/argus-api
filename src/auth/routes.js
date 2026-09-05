const express = require('express');
const service = require('./service');

const { loginLimiter, keyLoginLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/owner/register', keyLoginLimiter, async (req, res, next) => {
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
