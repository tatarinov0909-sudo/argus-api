const express = require('express');
const { requireAuth, requireRole, requireGrant } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { tenantContextFromAuth } = require('../auth/tenantContext');
const { HttpError } = require('../middleware/errorHandler');
const vw = require('./service');
const separate = require('./separate');
const batch = require('./batch');
const kladovshchik = require('../agents/kladovshchik');

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
// Грузчику — тоже: склад продавца выбирают при заведении возврата.
router.get('/', requireAuth, requireRole('seller', 'owner', 'manager', 'worker'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const out = await inSeller(req, async (c) => {
      const company = (await c.query('SELECT id, ff_rights FROM companies WHERE id = $1 AND archived_at IS NULL', [companyId])).rows[0];
      if (!company) throw new HttpError(404, 'Продавец не найден');
      // Зона склада — складу (продавцу она ни к чему).
      const list = await vw.list(c, companyId);
      if (req.auth.role !== 'seller') {
        for (const w of list) w.zone = await separate.zoneInfo(c, req.auth.warehouseId, w.id);
      } else {
        // Как товар хранится, продавцу не отдаём (уточнение владельца 03.10.2026).
        for (const w of list) { delete w.keepSeparate; delete w.defectSeparate; }
      }
      return {
        main: { id: null, name: vw.MAIN_NAME },
        warehouses: list,
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
      keepSeparate: b.keepSeparate, defectSeparate: b.defectSeparate, zone: b.zone, actor: await actorOf(c, req.auth),
    }));
    res.status(201).json(out);
  } catch (err) { next(err); }
});

router.patch('/:id([0-9a-fA-F-]{36})', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await inWarehouse(req, async (c) => vw.update(c, {
      warehouseId: req.auth.warehouseId, companyId: companyOf(req), id: req.params.id,
      name: b.name, marketplace: b.marketplace, keepSeparate: b.keepSeparate, defectSeparate: b.defectSeparate,
      zone: b.zone, separateExisting: b.separateExisting, actor: await actorOf(c, req.auth),
    }));
    res.json(out);
  } catch (err) { next(err); }
});

// Сколько товара склада уже лежит вместе с товаром других складов продавца —
// чтобы при включении «хранить отдельно» спросить, что с ним делать.
router.get('/:id([0-9a-fA-F-]{36})/mixed', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const out = await inWarehouse(req, (c) => separate.mixedCells(c, req.auth.warehouseId, companyId, req.params.id,
      { defect: req.query.defect === '1' }));
    const good = out.filter((m) => m.quality === 'good' || req.query.defect === '1');
    res.json({ cells: new Set(good.map((m) => m.cell_block_id)).size, units: good.reduce((n, m) => n + m.qty, 0) });
  } catch (err) { next(err); }
});

// Задания «переложить» (склад «хранить отдельно»): грузчику — список с
// подсказкой ячеек, шаг «переложил»; руководитель может снять задание.
router.get('/move-tasks', requireAuth, requireRole('worker', 'owner', 'manager'), async (req, res, next) => {
  try {
    const out = await inWarehouse(req, async (c) => {
      const tasks = await separate.listTasks(c, req.auth.warehouseId, { open: true });
      for (const t of tasks.slice(0, 50)) {
        t.suggest = t.quality === 'good'
          ? await kladovshchik.suggestCells(c, req.auth.warehouseId, t.sku, t.companyId, 3, { vw: t.toVw })
          : [];
        t.suggest = t.suggest.filter((o) => o.blockId !== t.fromCellBlockId);
      }
      return tasks;
    });
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

router.post('/move-tasks/:id/step', requireAuth, requireRole('worker', 'owner', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await inWarehouse(req, (c) => separate.step(c, req.auth.warehouseId, {
      taskId: req.params.id, toCellBlockId: b.toCellBlockId, qty: b.qty, staffKeyId: req.auth.staffKeyId || null,
    }));
    res.json(out);
  } catch (err) { next(err); }
});

router.post('/move-tasks/:id/cancel', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const out = await inWarehouse(req, async (c) => separate.cancelTask(c, req.auth.warehouseId, {
      taskId: req.params.id, note: (req.body || {}).note, actor: await actorOf(c, req.auth),
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

// Пакетный выбор, проверка Excel и запись. Права проверяются на сервере.
router.get('/transfer-candidates', requireAuth, requireRole('owner', 'manager'), requireGrant('warehouse'), async (req, res, next) => {
  try {
    const out = await inWarehouse(req, c => batch.candidates(c, req.auth.warehouseId, req.query));
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});
router.post('/transfers/preview', requireAuth, requireRole('owner', 'manager'), requireGrant('warehouse'), async (req, res, next) => {
  try {
    const out = await inWarehouse(req, c => batch.preview(c, req.auth.warehouseId, req.body));
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});
router.post('/transfers/batch', requireAuth, requireRole('owner', 'manager'), requireGrant('warehouse'), async (req, res, next) => {
  try {
    const out = await inWarehouse(req, async c => batch.commit(c, req.auth.warehouseId, req.body, await actorOf(c, req.auth)));
    res.status(out.replayed ? 200 : 201).set('Cache-Control', 'no-store').json(out);
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
    const ids = (req.body || {}).ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || ids.some((x) => !/^[0-9a-f-]{36}$/i.test(String(x))))) {
      throw new HttpError(400, 'Какие уведомления отметить — список номеров');
    }
    const n = await inSeller(req, (c) => vw.markSeen(c, req.auth.companyId, ids || null));
    res.json({ seen: n });
  } catch (err) { next(err); }
});

module.exports = router;
