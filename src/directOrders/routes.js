const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const service = require('./service');

// Заказы физлицам (владелец 08.10.2026): склад — любого своего продавца,
// продавец — только свои. Пишем в контексте склада (как заявки продавца на
// перенос), продавцу компания берётся из его входа, а не из запроса.
const router = express.Router();

const companyOf = (req, required = true) => {
  const id = req.auth.role === 'seller' ? req.auth.companyId : (req.body?.companyId || req.query.companyId || null);
  if (!id && required) throw new HttpError(400, 'Укажите продавца');
  return id;
};
const ownOnly = (req) => (req.auth.role === 'seller' ? req.auth.companyId : null);
async function actorOf(c, auth) {
  if (auth.role === 'seller') return { type: 'seller', id: auth.sellerKeyId || null, name: 'Продавец' };
  if (auth.role === 'owner') return { type: 'owner', id: auth.ownerId || null, name: 'Руководитель склада' };
  const s = (await c.query('SELECT name FROM staff_keys WHERE id = $1', [auth.staffKeyId])).rows[0];
  return { type: 'manager', id: auth.staffKeyId || null, name: s ? `Менеджер ${s.name}` : 'Менеджер склада' };
}
const inWarehouse = (req, fn) => withTenantContext({ warehouseId: req.auth.warehouseId }, fn);
const ROLES = requireRole('seller', 'owner', 'manager');

router.post('/', requireAuth, ROLES, async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await inWarehouse(req, async (c) => service.create(c, req.auth.warehouseId, {
      companyId: companyOf(req), vwId: b.vwId ?? null, items: b.items, recipient: b.recipient, address: b.address,
      phone: b.phone, deliveryService: b.deliveryService, plannedDate: b.plannedDate, comment: b.comment,
      toSupply: b.toSupply === true, requestId: b.requestId ?? null, actor: await actorOf(c, req.auth),
    }));
    res.status(out.replayed ? 200 : 201).json(out);
  } catch (err) { next(err); }
});

router.get('/', requireAuth, ROLES, async (req, res, next) => {
  try {
    const out = await inWarehouse(req, (c) => service.list(c, { companyId: companyOf(req, false) }));
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

// Трек-номер и статус после отъезда: { trackNumber } и/или { deliveryStatus }.
router.patch('/:id', requireAuth, ROLES, async (req, res, next) => {
  try {
    const out = await inWarehouse(req, async (c) => service.setDelivery(c, req.auth.warehouseId, req.params.id, {
      companyId: ownOnly(req), body: req.body || {}, actor: await actorOf(c, req.auth),
    }));
    res.json(out);
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, ROLES, async (req, res, next) => {
  try {
    const out = await inWarehouse(req, async (c) => service.cancel(c, req.auth.warehouseId, req.params.id, {
      companyId: ownOnly(req), actor: await actorOf(c, req.auth),
    }));
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
