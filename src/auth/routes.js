const express = require('express');
const service = require('./service');

const router = express.Router();

router.post('/owner/register', async (req, res, next) => {
  try {
    const result = await service.registerOwner(req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/owner/login', async (req, res, next) => {
  try {
    const result = await service.loginOwner(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/staff/login', async (req, res, next) => {
  try {
    const result = await service.loginStaffKey(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/seller/login', async (req, res, next) => {
  try {
    const result = await service.loginSellerKey(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
