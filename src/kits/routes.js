const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const kits = require('./kits');
const vwarehouses = require('../vwarehouses/service');

const router = express.Router();

// Склад набора (02.10.2026): набор для поставки этого продавца — со склада
// поставки; иначе «Основной».
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Строка листа отбора знает склад сама (vw) — тогда берём его: лист бывает
// по нескольким поставкам сразу.
async function kitVw(client, warehouseId, companyId, supplyId, body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, 'vw') && UUID.test(String(companyId || ''))) {
    const vw = await vwarehouses.requireVw(client, companyId, body.vw || null);
    return vw ? vw.id : null;
  }
  if (!UUID.test(String(supplyId || '')) || !UUID.test(String(companyId || ''))) return null;
  const s = (await client.query(
    'SELECT virtual_warehouse_id FROM supplies WHERE id = $1 AND warehouse_id = $2 AND company_id = $3',
    [supplyId, warehouseId, companyId])).rows[0];
  return s ? s.virtual_warehouse_id || null : null;
}

// Состав набора и сколько его можно собрать прямо сейчас.
// Работнику доступно: это подсказка у полки, а не чат (см. правило о том, что
// работник в чат не ходит) — он должен видеть, что и в каком количестве брать.
router.get('/:companyId/:kitSku', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId, kitSku } = req.params;
    const info = await withTenantContext({ warehouseId }, async (client) => (
      kits.kitInfo(client, warehouseId, companyId, kitSku, await kitVw(client, warehouseId, companyId, req.query.supplyId))
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
    const { warehouseId, staffKeyId } = req.auth;
    const { companyId, kitSku, qty, toCellBlockId } = req.body;
    const result = await withTenantContext({ warehouseId }, async (client) => (
      kits.assembleKit(client, warehouseId, {
        companyId, kitSku, qty, toCellBlockId, workerKeyId: staffKeyId || null,
        vw: await kitVw(client, warehouseId, companyId, req.body.supplyId, req.body),
      })
    ));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
