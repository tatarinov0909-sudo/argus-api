const express = require('express');
const { requireAuth, requireRole, requireGrant } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const credentials = require('./credentials');
const mapping = require('./mapping');
const sync = require('./sync');
const wb = require('./wb');
const reconciliation = require('./reconciliation');
const sellerWarehouses = require('./sellerWarehouses');

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

router.get('/reconciliation', requireRole('owner'), async (req, res, next) => {
  try {
    const result = await withTenantContext({ warehouseId: req.auth.warehouseId },
      c => reconciliation.list(c, req.auth.warehouseId, req.query.after || null));
    res.json(result);
  } catch (err) { next(err); }
});
router.get('/reconciliation/:id', requireRole('owner'), async (req, res, next) => {
  try {
    res.json(await withTenantContext({ warehouseId: req.auth.warehouseId },
      c => reconciliation.preview(c, req.auth.warehouseId, req.params.id)));
  } catch (err) { next(err); }
});
router.post('/reconciliation/:id', requireRole('owner'), async (req, res, next) => {
  try {
    res.json(await withTenantContext({ warehouseId: req.auth.warehouseId },
      c => reconciliation.resolve(c, req.auth.warehouseId, req.params.id,
        { ...req.body, ownerId: req.auth.ownerId })));
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId }, (c) => (
      credentials.list(c, warehouseId)
    ));
    res.json(rows);
  } catch (err) { next(err); }
});

/* ============ Склады WB ============
   Пункты приёмки, куда возит фулфилмент, и склады продавцов на WB. Всё —
   только чтение WB: меняется лишь то, какие заказы Аргус берёт в работу. */

const staffActor = async (c, auth) => {
  if (auth.role === 'owner') return { name: 'Руководитель склада', type: 'owner', id: auth.ownerId || null };
  const s = (await c.query('SELECT name FROM staff_keys WHERE id = $1', [auth.staffKeyId])).rows[0];
  return { name: s ? `Менеджер ${s.name}` : 'Менеджер склада', type: 'manager', id: auth.staffKeyId || null };
};

router.get('/wb/offices', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    res.json(await withTenantContext({ warehouseId }, (c) => sellerWarehouses.listOffices(c, warehouseId)));
  } catch (err) { next(err); }
});

// Пункт приёмки влияет на то, чьи заказы Аргус берёт в работу у всех
// продавцов сразу, — поэтому за тем же правом, что и ключи площадок.
router.put('/wb/offices/:officeId', requireGrant('marketplaces'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    if (typeof req.body?.on !== 'boolean') throw new HttpError(400, 'Передайте on: true или false');
    res.json(await withTenantContext({ warehouseId }, async (c) => sellerWarehouses.setOffice(
      c, warehouseId, req.params.officeId, req.body.on, await staffActor(c, req.auth),
      { importOrders: sync.importOrders })));
  } catch (err) { next(err); }
});

router.get('/:companyId/wb/warehouses', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    res.json(await withTenantContext({ warehouseId }, async (c) => {
      await companyOfWarehouse(c, warehouseId, req.params.companyId);
      return sellerWarehouses.list(c, warehouseId, req.params.companyId);
    }));
  } catch (err) { next(err); }
});

router.patch('/:companyId/wb/warehouses/:mpWarehouseId', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    if (typeof req.body?.ours !== 'boolean') throw new HttpError(400, 'Передайте ours: true или false');
    res.json(await withTenantContext({ warehouseId }, async (c) => {
      await companyOfWarehouse(c, warehouseId, req.params.companyId);
      return sellerWarehouses.setOurs(c, warehouseId, req.params.companyId, req.params.mpWarehouseId,
        req.body.ours, await staffActor(c, req.auth), { importOrders: sync.importOrders });
    }));
  } catch (err) { next(err); }
});

async function companyOfWarehouse(c, warehouseId, companyId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(companyId))) throw new HttpError(404, 'Продавец не найден');
  const r = await c.query('SELECT id FROM companies WHERE id = $1 AND warehouse_id = $2', [companyId, warehouseId]);
  if (!r.rows[0]) throw new HttpError(404, 'Продавец не найден');
}

/* ============ Сопоставление артикулов ============
   Объявлено выше `/:companyId/:marketplace`: у `DELETE /mapping/<id>`
   ровно столько же сегментов, и Express выбрал бы первый подошедший
   маршрут — то есть снял бы ключ площадки вместо строки сопоставления.

   Право — владельцу и менеджеру без отдельной галочки: это ежедневная
   работа по разбору очереди, и доступа она ни к чему не открывает.
   Менеджер, который не может сопоставить артикул, не может работать. */

router.get('/mapping/unresolved', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId },
      (c) => mapping.unresolved(c, warehouseId));
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/mapping/products', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId },
      (c) => mapping.searchProducts(c, warehouseId, req.query.companyId, req.query.q));
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/mapping', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId },
      (c) => mapping.list(c, warehouseId, req.query.companyId));
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/mapping', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId },
      (c) => mapping.save(c, warehouseId, req.body || {}));
    res.status(201).json(out);
  } catch (err) { next(err); }
});

router.delete('/mapping/:id', async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId },
      (c) => mapping.remove(c, warehouseId, req.params.id));
    res.json(out);
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

// Разрешить Аргусу менять статусы в кабинете продавца.
//
// Отдельное действие и отдельное право: до этого щелчка Аргус на площадке
// ничего не меняет. Согласие продавца на это берёт владелец склада — код
// проверить его не может, поэтому решение остаётся явным и записывается.
router.patch('/:companyId/:marketplace/write', requireGrant('marketplaces'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId, marketplace } = req.params;
    if (typeof req.body?.enabled !== 'boolean') {
      throw new HttpError(400, 'Передайте enabled: true или false');
    }
    const out = await withTenantContext({ warehouseId }, (c) => (
      credentials.setWriteEnabled(c, warehouseId, companyId, marketplace, req.body.enabled)
    ));
    res.json(out);
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
