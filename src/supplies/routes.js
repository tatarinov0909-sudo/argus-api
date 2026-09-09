const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { tenantContextFromAuth } = require('../auth/tenantContext');
const service = require('./service');

const router = express.Router();

const actorOf = (auth) => ({
  type: auth.role,
  id: auth.staffKeyId || auth.ownerId || null,
});

// Собрать поставку. Право владельца (и менеджера, когда роль появится):
// это решение «что уезжает сегодня», а не исполнение.
router.post('/', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { invoiceIds, marketplace, destination } = req.body || {};
    const supply = await withTenantContext({ warehouseId }, (client) => service.create(
      client, warehouseId, { invoiceIds, marketplace, destination, actor: actorOf(req.auth) },
    ));
    res.status(201).json(supply);
  } catch (err) { next(err); }
});

// Экран менеджера, первый взгляд: у кого накопились заказы. Не список
// заказов, а список продавцов с числом — по нему решают, чем заняться.
router.get('/pending', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId },
      (client) => service.pendingByCompany(client, warehouseId));
    res.json(rows);
  } catch (err) { next(err); }
});

// Заказы выбранного продавца.
router.get('/pending/:companyId', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId },
      (client) => service.pendingOrders(client, warehouseId, req.params.companyId));
    res.json(rows);
  } catch (err) { next(err); }
});

// Список поставок. Продавцу тоже: это его товар уезжает, и знать, когда
// и куда, — его законный интерес. Что он увидит, решает изоляция в базе.
router.get('/', requireAuth, requireRole('owner', 'manager', 'worker', 'seller'), async (req, res, next) => {
  try {
    const ctx = tenantContextFromAuth(req.auth);
    const rows = await withTenantContext(ctx, (client) => service.list(
      client, req.auth.warehouseId, { status: req.query.status || null },
    ));
    res.json(rows);
  } catch (err) { next(err); }
});

// Состав: и сводно «что взять со склада», и построчно «что положить
// в коробки». Работнику нужен первый, упаковщику второй — отдаём оба сразу,
// чтобы экран не ходил за данными дважды.
router.get('/:id', requireAuth, requireRole('owner', 'manager', 'worker', 'seller'), async (req, res, next) => {
  try {
    const ctx = tenantContextFromAuth(req.auth);
    const data = await withTenantContext(ctx, (client) => service.contents(
      client, req.auth.warehouseId, req.params.id,
    ));
    res.json(data);
  } catch (err) { next(err); }
});

// Собрана. Может отметить и работник: он её и собирал.
router.post('/:id/ready', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (client) => service.advance(
      client, warehouseId, req.params.id, { to: 'ready', actor: actorOf(req.auth) },
    ));
    res.json(out);
  } catch (err) { next(err); }
});

// Уехала. Событие в физическом мире, и назад его не отменить — см. service.
router.post('/:id/ship', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (client) => service.advance(
      client, warehouseId, req.params.id,
      { to: 'shipped', destination: (req.body || {}).destination || null, actor: actorOf(req.auth) },
    ));
    res.json(out);
  } catch (err) { next(err); }
});

// Разобрать поставку, пока она собирается. Право владельца и менеджера:
// это отмена их собственного решения, а не работа у полки.
router.delete('/:id', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (client) => service.disband(
      client, warehouseId, req.params.id, { actor: actorOf(req.auth) },
    ));
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
