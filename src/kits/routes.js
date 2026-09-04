const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const kits = require('./kits');

const router = express.Router();

// Состав набора и сколько его можно собрать прямо сейчас.
// Работнику доступно: это подсказка у полки, а не чат (см. правило о том, что
// работник в чат не ходит) — он должен видеть, что и в каком количестве брать.
router.get('/:companyId/:kitSku', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId, kitSku } = req.params;
    const info = await withTenantContext({ warehouseId }, (client) => (
      kits.kitInfo(client, warehouseId, companyId, kitSku)
    ));
    if (!info) throw new HttpError(404, 'Это не набор — состава для него нет');
    res.json(info);
  } catch (err) {
    next(err);
  }
});

// Собрать наборы: компоненты уходят с полки, наборы ложатся в ячейку.
router.post('/assemble', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId, kitSku, qty, toCellBlockId } = req.body;
    const result = await withTenantContext({ warehouseId }, (client) => (
      kits.assembleKit(client, warehouseId, { companyId, kitSku, qty, toCellBlockId })
    ));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
