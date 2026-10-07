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

// Составы наборов продавца — экран и файл (владелец 08.10.2026). Руководитель
// и менеджер: это каталог товара, как «Добавить товары» у прихода.
async function activeCompany(client, warehouseId, companyId) {
  if (!UUID.test(String(companyId || ''))) throw new HttpError(400, 'Неверный продавец');
  const c = (await client.query('SELECT id, name FROM companies WHERE id = $1 AND warehouse_id = $2 AND archived_at IS NULL',
    [companyId, warehouseId])).rows[0];
  if (!c) throw new HttpError(404, 'Продавец не найден');
  return c;
}
const journalOf = (req) => ({ actorType: req.auth.role, actorId: req.auth.staffKeyId || req.auth.ownerId || null });

router.get('/company/:companyId', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    res.json(await withTenantContext({ warehouseId }, async (client) => {
      await activeCompany(client, warehouseId, req.params.companyId);
      return kits.list(client, warehouseId, req.params.companyId);
    }));
  } catch (err) { next(err); }
});

router.put('/company/:companyId/kit', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    res.json(await withTenantContext({ warehouseId }, async (client) => {
      const company = await activeCompany(client, warehouseId, req.params.companyId);
      const saved = await kits.save(client, warehouseId, company.id, req.body?.kitSku, req.body?.components);
      await require('../journal/repository').createEntry(client, {
        warehouseId, agent: 'Кладовщик', status: 'auto', ...journalOf(req),
        actionText: saved.components.length
          ? `Состав набора ${saved.kitSku} продавца «${company.name}»: `
            + saved.components.map((p) => `${p.sku} × ${p.qty}`).join(', ') + '.'
          : `Набор ${saved.kitSku} продавца «${company.name}» больше не набор — состав убран.`,
      });
      return saved;
    }));
  } catch (err) { next(err); }
});

router.post('/company/:companyId/import', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    res.json(await withTenantContext({ warehouseId }, async (client) => {
      const company = await activeCompany(client, warehouseId, req.params.companyId);
      const out = await kits.importRows(client, warehouseId, company.id, req.body?.rows, { apply: req.body?.apply === true });
      if (out.applied && out.ok) {
        await require('../journal/repository').createEntry(client, {
          warehouseId, agent: 'Кладовщик', status: 'auto', ...journalOf(req),
          actionText: `Составы наборов продавца «${company.name}» загружены файлом: ${out.ok}`
            + (out.errors.length ? `, не загружено с ошибками: ${out.errors.length}.` : '.'),
        });
      }
      return out;
    }));
  } catch (err) { next(err); }
});

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
