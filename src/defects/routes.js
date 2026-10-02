const express = require('express');
const { requireAuth, requireRole, requireGrant } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { tenantContextFromAuth } = require('../auth/tenantContext');
const journal = require('../journal/repository');
const defects = require('./service');

// Склад брака (владелец 02.10.2026): то, что делает склад. Решения продавца —
// в sellers/routes.js (/api/sellers/defects).
const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
// Телефон сжимает фото до ~200 КБ; запас — на случай, когда сжать не вышло.
const MAX_PHOTO = 3 * 1024 * 1024;

const inWarehouse = (req, fn) => withTenantContext({ warehouseId: req.auth.warehouseId }, fn);

async function activeCompany(client, warehouseId, companyId) {
  if (!UUID.test(String(companyId || ''))) throw new HttpError(400, 'Укажите продавца');
  const c = (await client.query(
    'SELECT id, name FROM companies WHERE id = $1 AND warehouse_id = $2 AND archived_at IS NULL',
    [companyId, warehouseId])).rows[0];
  if (!c) throw new HttpError(404, 'Продавец не найден');
  return c;
}

// Куда положить брак: ячейки брака этого продавца, ячейки брака склада, пустые.
router.get('/cells', requireAuth, requireRole('worker', 'owner', 'manager'), async (req, res, next) => {
  try {
    const out = await inWarehouse(req, async (c) => {
      await activeCompany(c, req.auth.warehouseId, req.query.companyId);
      const vwArg = typeof req.query.vw === 'string' ? req.query.vw : '';
      const vw = !vwArg ? undefined : vwArg === 'main' ? null : (/^[0-9a-f-]{36}$/i.test(vwArg) ? vwArg : undefined);
      return defects.suggestCells(c, req.auth.warehouseId, req.query.companyId, 6, { vw });
    });
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

// Брак нашёлся на полке среди годного — при сборке или перекладке. Годное
// снимается с ячейки, брак ложится в ячейку брака, документ — «Перемещение на
// склад брака».
router.post('/moves', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const source = b.source === 'move' ? 'move' : 'picking';
    const out = await inWarehouse(req, async (c) => {
      await activeCompany(c, req.auth.warehouseId, b.companyId);
      if (typeof b.sku !== 'string' || !b.sku) throw new HttpError(400, 'Укажите товар');
      // С какого виртуального склада годное (02.10.2026): сборка поставки —
      // склад поставки, сборка заказа — склад строки; иначе — переданный
      // склад или любой (каждая строка остаётся со своим складом).
      let vw = Object.prototype.hasOwnProperty.call(b, 'vw') ? (b.vw || null) : undefined;
      if (UUID.test(String(b.supplyId || ''))) {
        const s = (await c.query('SELECT virtual_warehouse_id FROM supplies WHERE id = $1 AND warehouse_id = $2',
          [b.supplyId, req.auth.warehouseId])).rows[0];
        if (s) vw = s.virtual_warehouse_id || null;
      } else if (UUID.test(String(b.invoiceItemId || ''))) {
        const it = (await c.query('SELECT virtual_warehouse_id FROM invoice_items WHERE id = $1 AND warehouse_id = $2',
          [b.invoiceItemId, req.auth.warehouseId])).rows[0];
        if (it) vw = it.virtual_warehouse_id || null;
      }
      return defects.markFromShelf(c, {
        warehouseId: req.auth.warehouseId, companyId: b.companyId, sku: b.sku,
        fromCellBlockId: b.fromCellBlockId, toCellBlockId: b.toCellBlockId || null, qty: b.qty,
        bucket: b.bucket, note: b.note, source,
        supplyId: UUID.test(String(b.supplyId || '')) ? b.supplyId : null,
        invoiceId: UUID.test(String(b.invoiceId || '')) ? b.invoiceId : null,
        staffKeyId: req.auth.staffKeyId, vw,
      });
    });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

async function findMove(client, auth, id) {
  if (!UUID.test(String(id || ''))) throw new HttpError(404, 'Документ не найден');
  const m = (await client.query(
    'SELECT id, company_id, created_by FROM defect_moves WHERE id = $1', [id])).rows[0];
  if (!m || (auth.role === 'seller' && m.company_id !== auth.companyId)) throw new HttpError(404, 'Документ не найден');
  return m;
}

// Фото брака. Файл читаем после проверки входа: чужой не зальёт 3 МБ.
const rawPhoto = express.raw({ type: () => true, limit: MAX_PHOTO });
const readPhoto = (req, res, next) => rawPhoto(req, res, (err) => next(err && err.type === 'entity.too.large'
  ? new HttpError(413, 'Фото больше 3 МБ — снимите ещё раз') : err));

router.put('/moves/:id/photo', requireAuth, requireRole('worker', 'owner', 'manager'), readPhoto, async (req, res, next) => {
  try {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!PHOTO_TYPES.includes(type)) throw new HttpError(400, 'Фото — JPG, PNG, WEBP или HEIC');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Фото пустое');
    await inWarehouse(req, async (c) => {
      const m = await findMove(c, req.auth, req.params.id);
      await c.query(
        'UPDATE defect_moves SET photo = $2, photo_type = $3, photo_size = $4, photo_at = now() WHERE id = $1',
        [m.id, req.body, type, req.body.length]);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/moves/:id/photo', requireAuth, requireRole('seller', 'worker', 'owner', 'manager'), async (req, res, next) => {
  try {
    const photo = await withTenantContext(tenantContextFromAuth(req.auth), async (c) => {
      const m = await findMove(c, req.auth, req.params.id);
      return (await c.query('SELECT photo, photo_type FROM defect_moves WHERE id = $1', [m.id])).rows[0];
    });
    if (!photo || !photo.photo) throw new HttpError(404, 'Фото не приложено');
    res.set('Content-Type', photo.photo_type);
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(photo.photo);
  } catch (err) { next(err); }
});

// Задания грузчику: решения по браку, которые склад ещё не выполнил.
router.get('/tasks', requireAuth, requireRole('worker', 'owner', 'manager'), async (req, res, next) => {
  try {
    const out = await inWarehouse(req, (c) => defects.tasks(c, req.auth.warehouseId));
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

router.post('/tasks/:id/done', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const out = await inWarehouse(req, (c) => defects.execute(c, {
      warehouseId: req.auth.warehouseId, decisionId: req.params.id, staffKeyId: req.auth.staffKeyId,
      cellBlockId: (req.body || {}).cellBlockId || null,
    }));
    res.json(out);
  } catch (err) { next(err); }
});

// Ячейка брака: руководитель отмечает на карте, куда класть брак.
router.patch('/zones/:cellBlockId', requireAuth, requireGrant('warehouse'), async (req, res, next) => {
  try {
    const on = (req.body || {}).on === true;
    const out = await inWarehouse(req, async (c) => {
      const label = await defects.cellLabel(c, req.auth.warehouseId, req.params.cellBlockId);
      await c.query('UPDATE cell_blocks SET defect_zone = $2 WHERE id = $1 AND warehouse_id = $3',
        [req.params.cellBlockId, on, req.auth.warehouseId]);
      await journal.createEntry(c, {
        warehouseId: req.auth.warehouseId, agent: 'Кладовщик', status: 'auto',
        actionText: on ? `Ячейка ${label} отмечена как ячейка брака — брак будет предлагаться сюда первым.`
          : `Ячейка ${label} больше не ячейка брака.`,
        entityType: 'cell_block', entityId: req.params.cellBlockId, cellBlockId: req.params.cellBlockId,
        actorType: req.auth.role === 'manager' ? 'manager' : 'owner',
        actorId: req.auth.role === 'manager' ? req.auth.staffKeyId : req.auth.ownerId,
      });
      return { cellBlockId: req.params.cellBlockId, defectZone: on };
    });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
