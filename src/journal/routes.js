const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const repository = require('./repository');

const router = express.Router();

// Journal is owner-only (workers act, they don't watch the log; sellers
// never see it at all — see the RLS policy note in the initial migration).
router.get('/', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    // ?cellBlockId= / ?invoiceId= — история одного места или одного документа.
    // Фильтруем в базе, а не в кабинете: в ленте лежат последние 200 записей,
    // и старая история ячейки в них попросту не попадёт.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const one = (v, name) => {
      if (!v) return null;
      if (!uuid.test(String(v))) throw new HttpError(400, `Некорректный ${name}`);
      return String(v);
    };
    const cellBlockId = one(req.query.cellBlockId, 'cellBlockId');
    const invoiceId = one(req.query.invoiceId, 'invoiceId');

    const hideUrgent = req.auth.role === 'manager' && !(req.auth.grants || []).includes('shortages');
    const entries = await withTenantContext({ warehouseId }, async (client) => {
      const rows = await repository.listEntries(client, warehouseId, { cellBlockId, invoiceId, hideUrgent });
      // Сборка поставки уходит в кабинет одной записью с полосой готовности,
      // поэтому к строкам этой поставки прикладываем её счёт позиций.
      const supplyIds = [...new Set(rows.map((r) => r.invoice_supply_id).filter(Boolean))];
      const progress = await repository.supplyPickProgress(client, warehouseId, supplyIds);
      rows.forEach((row) => {
        const done = progress.get(row.invoice_supply_id);
        if (!done) return;
        row.supply_items_total = done.total;
        row.supply_items_done = done.done;
      });
      return rows;
    });
    res.json(entries);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resolve', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId, ownerId, role, staffKeyId } = req.auth;
    const { id } = req.params;
    const { resolution, note } = req.body; // resolution: 'confirm' | 'rollback'
    if (!['confirm', 'rollback'].includes(resolution)) {
      throw new HttpError(400, 'resolution должен быть confirm или rollback');
    }

    const entry = await withTenantContext({ warehouseId }, async (client) => {
      const original = await client.query(
        `SELECT agent, urgent,
                EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id) AS answered
           FROM journal_entries je WHERE id = $1 AND warehouse_id = $2`,
        [id, warehouseId],
      );
      if (!original.rows[0]) return null;
      // Второй ответ на одну запись — два противоречащих решения в следе.
      // Так бывает с открытого давно кабинета: заказ уже убрали из поставки,
      // а на экране ещё висит «Принять».
      if (original.rows[0].answered) throw new HttpError(409, 'По этой записи уже решено');
      // Срочную отметку решает тот, кому она адресована: менеджер без права
      // «отметки о нехватке» её и не видит.
      if (original.rows[0].urgent && role === 'manager' && !(req.auth.grants || []).includes('shortages')) {
        throw new HttpError(403, 'Отметки «нет товара» решает владелец или менеджер с этим правом');
      }
      if (original.rows[0].agent === 'Обмен с WB') {
        throw new HttpError(409, 'Решение по заказу WB принимается в разделе «Сверка заказов WB»');
      }
      return repository.resolveEntry(client, {
        warehouseId, originalEntryId: id, resolution, resolvedByOwnerId: ownerId, note,
        actorType: role === 'manager' ? 'manager' : 'owner',
        actorId: ownerId || staffKeyId || null,
      });
    });
    if (!entry) throw new HttpError(404, 'Запись не найдена');
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

// Грузчик поставил работу на паузу или вернулся к ней — руководитель видит
// это в журнале сразу, а не в итоге накладной (владелец 26.09.2026).
// Работник журнал не читает, он только сообщает.
router.post('/pause', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const body = req.body || {};
    const { reason, resumed, pausedMs } = body;
    const uuid = (v) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
    const invoiceId = uuid(body.invoiceId);
    const supplyId = uuid(body.supplyId);
    const why = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    if (!why) throw new HttpError(400, 'Нужна причина паузы');
    const entry = await withTenantContext({ warehouseId }, async (client) => {
      const who = await client.query('SELECT name FROM staff_keys WHERE id = $1', [staffKeyId]);
      const doc = invoiceId ? (await client.query(
        `SELECT i.id, i.number, s.number AS supply_number FROM invoices i
           LEFT JOIN supplies s ON s.id = i.supply_id
          WHERE i.id = $1 AND i.warehouse_id = $2`, [invoiceId, warehouseId])).rows[0] : null;
      const sup = !doc && supplyId ? (await client.query(
        'SELECT number FROM supplies WHERE id = $1 AND warehouse_id = $2', [supplyId, warehouseId])).rows[0] : null;
      const where = doc
        ? (doc.supply_number ? ` Поставка «${doc.supply_number}», заказ «${doc.number}».` : ` Документ «${doc.number}».`)
        : sup ? ` Поставка «${sup.number}».` : '';
      const name = who.rows[0] ? who.rows[0].name : 'Грузчик';
      const ms = Number(pausedMs) || 0;
      const took = ms < 60000 ? 'меньше минуты' : `${Math.round(ms / 60000)} мин`;
      return repository.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        actionText: resumed
          ? `${name} вернулся к работе после паузы (${took}): ${why}.${where}`
          : `${name} поставил работу на паузу: ${why}.${where}`,
        entityType: 'worker_pause',
        invoiceId: doc ? doc.id : null,
        actorType: 'worker',
        actorId: staffKeyId,
      });
    });
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
