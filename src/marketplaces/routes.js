const express = require('express');
const { requireAuth, requireRole, requireGrant } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const credentials = require('./credentials');
const sync = require('./sync');
const wb = require('./wb');

const router = express.Router();

// Работник к площадкам отношения не имеет вовсе: он видит задание на отбор,
// а откуда оно приехало — не его дело и не его дверь.
//
// Менеджера пускаем, но не всюду. Разница не в должности, а в том, что
// делает запрос: забрать заказы — это чтение с площадки и прямая работа
// менеджера, а вот привязать или снять ключ API — распоряжение доступом
// к чужому кабинету, и это решение владельца. Поэтому список и синхронизация
// открыты обоим, а ключи — за отдельным правом.
router.use(requireAuth, requireRole('owner', 'manager'));

router.get('/', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId }, (c) => (
      credentials.list(c, warehouseId)
    ));
    res.json(rows);
  } catch (err) { next(err); }
});

// Подключить ключ. Перед сохранением обязательно ходим на площадку: ключ,
// который не проверили, выглядит подключённым и молчит, а разбираться в этом
// придётся через неделю, когда заказы «почему-то не приходят».
router.post('/credentials', requireGrant('marketplaces'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId, marketplace, token } = req.body;
    if (marketplace !== 'wb') {
      throw new HttpError(400, 'Пока подключается только Wildberries');
    }
    if (!token) throw new HttpError(400, 'Не передан ключ');

    const who = await wb.sellerInfo(token);

    const saved = await withTenantContext({ warehouseId }, (c) => (
      credentials.save(c, warehouseId, { companyId, marketplace, token })
    ));
    res.status(201).json({ ...saved, seller: who });
  } catch (err) { next(err); }
});

router.delete('/:companyId/:marketplace', requireGrant('marketplaces'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId, marketplace } = req.params;
    const out = await withTenantContext({ warehouseId }, (c) => (
      credentials.remove(c, warehouseId, companyId, marketplace)
    ));
    res.json(out);
  } catch (err) { next(err); }
});

// Проверка связи: кто продавец и какие у него склады на площадке. Ничего не
// меняет, ничего не сохраняет — нужна ровно чтобы убедиться, что подключились
// к тому, к кому собирались.
router.get('/:companyId/wb/check', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId } = req.params;
    const out = await withTenantContext({ warehouseId }, async (c) => {
      const token = await credentials.tokenFor(c, warehouseId, companyId, 'wb');
      const [seller, whs] = await Promise.all([wb.sellerInfo(token), wb.warehouses(token)]);
      await credentials.markUsed(c, warehouseId, companyId, 'wb');
      return { seller, warehouses: whs };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// Забрать заказы вручную. Тот же код, что и по расписанию: одна дорога, чтобы
// «у меня по кнопке работает, а само — нет» было невозможно.
router.post('/sync', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId } = req.body || {};
    const out = await withTenantContext({ warehouseId }, (c) => (
      companyId
        ? sync.pullWildberries(c, warehouseId, { companyId })
        : sync.pullAll(c, warehouseId)
    ));
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
