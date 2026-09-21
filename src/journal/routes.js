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
    const entries = await withTenantContext({ warehouseId }, (client) => (
      repository.listEntries(client, warehouseId, { cellBlockId, invoiceId, hideUrgent })
    ));
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
        'SELECT agent, urgent FROM journal_entries WHERE id = $1 AND warehouse_id = $2',
        [id, warehouseId],
      );
      if (!original.rows[0]) return null;
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

module.exports = router;
