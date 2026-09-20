const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { HttpError } = require('../middleware/errorHandler');
const { withTenantContext } = require('../db/pool');
const { tenantContextFromAuth } = require('../auth/tenantContext');
const service = require('./service');
const wbHandoff = require('./wbHandoff');
const wb = require('../marketplaces/wb');
const credentials = require('../marketplaces/credentials');

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
    const {
      invoiceIds, marketplace, destination, shipDate, shippingPointId,
    } = req.body || {};
    const supply = await withTenantContext({ warehouseId }, (client) => service.create(client, warehouseId, {
      invoiceIds, marketplace, destination, shipDate, shippingPointId, actor: actorOf(req.auth),
    }));

    // Передача на площадку — отдельным шагом и вне транзакции: чужая сеть не
    // должна держать открытым соединение с базой. Пока владелец не включил
    // запись, шаг ничего не делает и поставка остаётся только местной.
    let marketplaceResult = null;
    if (supply.marketplaceOrders.length > 0) {
      marketplaceResult = await wbHandoff.handOver({
        warehouseId,
        companyId: supply.companyId,
        supply,
        orders: supply.marketplaceOrders,
        withTx: (fn) => withTenantContext({ warehouseId }, fn),
      }).catch((err) => ({ error: err.message }));
    }
    res.status(201).json({ ...supply, marketplace: marketplaceResult });
  } catch (err) { next(err); }
});

// Пункты приёма WB, куда можно везти поставку этого продавца. Только чтение
// ключом продавца. Город и габарит — Москва и обычный товар (решение
// владельца 19.09.2026); станут настройкой склада, когда появится второй.
router.get('/shipping-points/:companyId', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const token = await withTenantContext({ warehouseId },
      (client) => credentials.tokenFor(client, warehouseId, req.params.companyId, 'wb'));
    res.json(await wb.shippingPoints(token, { city: 'Москва', cargoType: 1 }));
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
    if (req.auth.role === 'seller') {
      // Продавцу — что и сколько уезжает, без адресов ячеек: раскладка склада
      // его не касается и в других местах от него скрыта.
      data.picking = data.picking.map(({ cells, available, ...rest }) => rest);
    }
    res.json(data);
  } catch (err) { next(err); }
});

// Уехала. Событие в физическом мире, и назад его не отменить — см. service.
// Отмечает тот, кто видит машину: менеджер, владелец или грузчик.
// «Собрана» отдельной кнопки не имеет — она ставится сама по отбору.
router.post('/:id/ship', requireAuth, requireRole('owner', 'manager', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (client) => service.ship(
      client, warehouseId, req.params.id,
      { destination: (req.body || {}).destination || null, actor: actorOf(req.auth) },
    ));

    // Машина ушла — на площадке поставку надо передать в доставку. Неудача
    // здесь не отменяет отгрузку: она уже случилась в физическом мире.
    const marketplaceResult = await wbHandoff.deliver({
      warehouseId,
      companyId: out.companyId,
      supply: out,
      withTx: (fn) => withTenantContext({ warehouseId }, fn),
    }).catch((err) => ({ error: err.message }));
    res.json({ ...out, marketplace: marketplaceResult });
  } catch (err) { next(err); }
});

// Повторить передачу поставки в доставку на WB.
//
// Журнал прямо советует «повторите из Аргуса», когда площадка не ответила, —
// а повторить было нечем: «Уехала» второй раз не нажимается (поставка уже
// уехала), и поставка оставалась висеть на WB «на сборке» навсегда.
router.post('/:id/marketplace/deliver', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const supply = await withTenantContext({ warehouseId }, (client) => client.query(
      `SELECT id, number, company_id, status, mp_supply_id, mp_delivered_at,
              mp_shipping_point_id, mp_shipping_set_at, to_char(ship_date, 'YYYY-MM-DD') AS ship_date
         FROM supplies WHERE warehouse_id = $1 AND id = $2`,
      [warehouseId, req.params.id],
    ).then((r) => r.rows[0]));
    if (!supply) throw new HttpError(404, 'Поставка не найдена');
    if (!supply.mp_supply_id) throw new HttpError(409, 'Этой поставки нет на площадке');
    if (supply.mp_delivered_at) return res.json({ alreadyDelivered: true });
    if (supply.status !== 'shipped') {
      throw new HttpError(409, 'Поставка ещё не уехала — передавать её в доставку рано');
    }
    const result = await wbHandoff.deliver({
      warehouseId,
      companyId: supply.company_id,
      supply,
      withTx: (fn) => withTenantContext({ warehouseId }, fn),
    }).catch((err) => ({ error: err.message }));
    res.json(result);
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
