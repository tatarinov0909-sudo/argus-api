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

// Отметки «нет товара» видят владелец и менеджер с правом «отметки о
// нехватке» — так решил владелец. Грузчику и продавцу — нет.
const seesShortages = (auth) => auth.role === 'owner'
  || (auth.role === 'manager' && (auth.grants || []).includes('shortages'));

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

// Пункты приёма WB, куда можно везти поставку этого продавца, — все, что WB
// показывает продавцу в его кабинете (решение владельца 25.09.2026), а не
// только Москва: без города WB отдаёт весь список, 80 с лишним тысяч пунктов
// и две сотни сортировочных центров. Только чтение ключом продавца.
//
// В браузер весь список не отдаём — это мегабайты. Держим его здесь шесть
// часов и отвечаем на поиск: ?q= — город, адрес или название; без q —
// сортировочные центры, их и выбирают чаще всего.
const POINTS_TTL_MS = 6 * 60 * 60 * 1000;
// Ключ кэша — склад и продавец: по одному продавцу чужой склад получал бы
// список, взятый ключом этого продавца (проверка 25.09.2026). Пустой ответ
// WB — сбой, а не «пунктов нет»: его не запоминаем, спросим в следующий раз.
const pointsCache = new Map(); // `${warehouseId}:${companyId}` → { at, points }
const POINTS_LIMIT = 40;

async function allPoints(companyId, warehouseId) {
  const key = `${warehouseId}:${companyId}`;
  const cached = pointsCache.get(key);
  if (cached && Date.now() - cached.at < POINTS_TTL_MS) return cached.points;
  const token = await withTenantContext({ warehouseId },
    (client) => credentials.tokenFor(client, warehouseId, companyId, 'wb'));
  const points = await wb.shippingPoints(token, { city: '', cargoType: 1 });
  if (Array.isArray(points) && points.length) pointsCache.set(key, { at: Date.now(), points });
  return points || [];
}

router.get('/shipping-points/:companyId', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const points = await allPoints(req.params.companyId, warehouseId);
    const words = String(req.query.q || '').toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, 6);
    const rank = (p) => (p.officeType === 'sc' ? 0 : p.fulfillment ? 1 : 2);
    const found = words.length
      ? points.filter((p) => {
        const hay = `${p.name || ''} ${p.address || ''} ${p.city || ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      : points.filter((p) => p.officeType === 'sc');
    found.sort((a, b) => rank(a) - rank(b) || String(a.address || '').localeCompare(String(b.address || ''), 'ru'));
    res.json({ total: found.length, points: found.slice(0, words.length ? POINTS_LIMIT : 300) });
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
      client, req.auth.warehouseId, { status: req.query.status || null, showShortages: seesShortages(req.auth) },
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
      client, req.auth.warehouseId, req.params.id, { showShortages: seesShortages(req.auth) },
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

// Убрать заказ из поставки — ответ на отметку грузчика «нет товара»: заказ
// возвращается в очередь, поставка едет без него. Право владельца и
// менеджера: состав поставки — их решение (см. service.removeOrder).
router.post('/orders/:invoiceId/remove', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (client) => service.removeOrder(
      client, warehouseId, req.params.invoiceId,
      { actor: actorOf(req.auth), canResolveShortages: seesShortages(req.auth) },
    ));
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
