const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const repository = require('./repository');

const router = express.Router();

// Journal is owner-only (workers act, they don't watch the log; sellers
// never see it at all — see the RLS policy note in the initial migration).
router.get('/', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const entries = await withTenantContext({ warehouseId }, (client) => repository.listEntries(client, warehouseId));
    res.json(entries);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resolve', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId, ownerId } = req.auth;
    const { id } = req.params;
    const { resolution, note } = req.body; // resolution: 'confirm' | 'rollback'
    if (!['confirm', 'rollback'].includes(resolution)) {
      throw new HttpError(400, 'resolution должен быть confirm или rollback');
    }

    const entry = await withTenantContext({ warehouseId }, (client) => repository.resolveEntry(client, {
      warehouseId, originalEntryId: id, resolution, resolvedByOwnerId: ownerId, note,
    }));
    if (!entry) throw new HttpError(404, 'Запись не найдена');
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
