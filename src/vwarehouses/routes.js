const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { tenantContextFromAuth } = require('../auth/tenantContext');
const { HttpError } = require('../middleware/errorHandler');
const vw = require('./service');

// Виртуальные склады продавца (владелец 02.10.2026). Склады заводит склад
// (руководитель, менеджер); продавец их видит, просит перенос и включает или
// выключает «права склада».
const router = express.Router();

// Продавец — свой продавец; склад — тот, что передан в companyId.
const companyOf = (req) => {
  const id = req.auth.role === 'seller' ? req.auth.companyId : (req.body?.companyId || req.query.companyId);
  if (!id) throw new HttpError(400, 'Укажите продавца');
  return id;
};
async function actorOf(c, auth) {
  if (auth.role === 'seller') return { role: 'seller', id: auth.sellerKeyId || null, companyId: auth.companyId, name: 'Продавец' };
  if (auth.role === 'owner') return { role: 'owner', id: auth.ownerId || null, name: 'Руководитель склада' };
  const s = (await c.query('SELECT name FROM staff_keys WHERE id = $1', [auth.staffKeyId])).rows[0];
  return { role: 'manager', id: auth.staffKeyId || null, name: s ? `Менеджер ${s.name}` : 'Менеджер склада' };
}
const inSeller = (req, fn) => withTenantContext(tenantContextFromAuth(req.auth), fn);
const inWarehouse = (req, fn) => withTenantContext({ warehouseId: req.auth.warehouseId }, fn);

// Склады продавца, его права и склады для поставки на WB.
router.get('/', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const out = await inSeller(req, async (c) => {
      const company = (await c.query('SELECT id, ff_rights FROM companies WHERE id = $1 AND archived_at IS NULL', [companyId])).rows[0];
      if (!company) throw new HttpError(404, 'Продавец не найден');
      return {
        main: { id: null, name: vw.MAIN_NAME },
        warehouses: await vw.list(c, companyId),
        rights: vw.rightsOf(company),
        wbChoices: await vw.wbChoices(c, companyId),
      };
    });
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await inWarehouse(req, async (c) => vw.create(c, {
      warehouseId: req.auth.warehouseId, companyId: companyOf(req), name: b.name, marketplace: b.marketplace,
      keepSeparate: b.keepSeparate, actor: await actorOf(c, req.auth),
    }));
    res.status(201).json(out);
  } catch (err) { next(err); }
});

router.patch('/:id([0-9a-fA-F-]{36})', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await inWarehouse(req, async (c) => vw.update(c, {
      warehouseId: req.auth.warehouseId, companyId: companyOf(req), id: req.params.id,
      name: b.name, marketplace: b.marketplace, keepSeparate: b.keepSeparate, actor: await actorOf(c, req.auth),
    }));
    res.json(out);
  } catch (err) { next(err); }
});

router.delete('/:id([0-9a-fA-F-]{36})', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    await inWarehouse(req, async (c) => vw.archive(c, {
      warehouseId: req.auth.warehouseId, companyId: companyOf(req), id: req.params.id, actor: await actorOf(c, req.auth),
    }));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Перенос товара между складами; у продавца — заявка складу.
router.post('/transfers', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const companyId = companyOf(req);
    const out = await inWarehouse(req, async (c) => vw.transfer(c, {
      warehouseId: req.auth.warehouseId, companyId, sku: b.sku, qty: b.qty, fromVw: b.fromVw ?? null, toVw: b.toVw ?? null,
      note: b.note, actor: await actorOf(c, req.auth),
    }));
    res.status(201).json(out);
  } catch (err) { next(err); }
});

router.get('/transfers', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const out = await inSeller(req, (c) => vw.listTransfers(c, companyId, { open: req.query.open === '1' }));
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

// Решение по переносу: склад — по заявке продавца, продавец — по просьбе
// склада, когда у него отключено право «переносить без согласия».
router.post('/transfers/:id/decide', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (typeof b.approve !== 'boolean') throw new HttpError(400, 'Выполнить или отказать?');
    const out = await inWarehouse(req, async (c) => vw.decide(c, {
      warehouseId: req.auth.warehouseId, transferId: req.params.id, approve: b.approve, reason: b.reason,
      actor: await actorOf(c, req.auth),
    }));
    res.json(out);
  } catch (err) { next(err); }
});

// Спорные ситуации с количеством, которые ждут продавца (он запретил складу
// решать без него): список — продавцу и складу, решает только продавец.
router.get('/decisions', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const out = await inSeller(req, (c) => vw.listDecisions(c, companyId, { open: req.query.open === '1' }));
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

router.post('/decisions/:id', requireAuth, requireRole('seller'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await inWarehouse(req, async (c) => vw.resolveDecision(c, {
      warehouseId: req.auth.warehouseId, decisionId: req.params.id, chosen: b.chosen, confirm: b.confirm === true,
      actor: await actorOf(c, req.auth),
    }));
    res.json(out);
  } catch (err) { next(err); }
});

// Склад у строк документа до начала работы — руководитель и менеджер.
router.post('/items', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await inWarehouse(req, async (c) => vw.setItemsVw(c, {
      warehouseId: req.auth.warehouseId, itemIds: b.itemIds, vwId: b.vw ?? null, actor: await actorOf(c, req.auth),
    }));
    res.json(out);
  } catch (err) { next(err); }
});

// «Права склада» — включает и выключает только сам продавец.
router.patch('/rights', requireAuth, requireRole('seller'), async (req, res, next) => {
  try {
    const out = await inWarehouse(req, (c) => vw.setRights(c, {
      warehouseId: req.auth.warehouseId, companyId: req.auth.companyId, rights: req.body?.rights,
    }));
    res.json({ rights: out });
  } catch (err) { next(err); }
});

// Уведомления продавцу: что склад сделал с его товаром.
router.get('/notifications', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const out = await inSeller(req, (c) => vw.notifications(c, companyId));
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

router.post('/notifications/seen', requireAuth, requireRole('seller'), async (req, res, next) => {
  try {
    const n = await inSeller(req, (c) => vw.markSeen(c, req.auth.companyId));
    res.json({ seen: n });
  } catch (err) { next(err); }
});

module.exports = router;
