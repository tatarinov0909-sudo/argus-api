const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const service = require('./service');

const router = express.Router();

// Регулировка — только владельцу: как часто считать, сколько ячеек за раз и
// какая пауза между заходами. Это решение про то, сколько смены отдать под
// счёт, и принимать его работнику не с чем.
router.get('/settings', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const s = await withTenantContext({ warehouseId }, (c) => service.getSettings(c, warehouseId));
    res.json({
      recountAfterDays: s.recount_after_days,
      cellsPerRun: s.cells_per_run,
      minDaysBetweenRuns: s.min_days_between_runs,
    });
  } catch (err) { next(err); }
});

router.patch('/settings', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const s = await withTenantContext({ warehouseId }, (c) => service.saveSettings(c, warehouseId, {
      recount_after_days: req.body.recountAfterDays,
      cells_per_run: req.body.cellsPerRun,
      min_days_between_runs: req.body.minDaysBetweenRuns,
    }));
    res.json({
      recountAfterDays: s.recount_after_days,
      cellsPerRun: s.cells_per_run,
      minDaysBetweenRuns: s.min_days_between_runs,
    });
  } catch (err) { next(err); }
});

// Что правило предложило бы сейчас — без создания заданий. Владелец видит,
// что именно уйдёт в работу, до того как отправит туда человека.
router.get('/preview', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId }, async (c) => {
      const s = await service.getSettings(c, warehouseId);
      const cells = await service.pickCells(c, warehouseId, {
        recountAfterDays: s.recount_after_days, limit: s.cells_per_run,
      });
      return { cells };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// Назначить пересчёт. Единственная точка, где задания появляются: работник
// сам инвентаризацию не начинает.
router.post('/runs', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId, ownerId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (c) => (
      service.createRun(c, warehouseId, ownerId)
    ));
    res.status(201).json(out);
  } catch (err) { next(err); }
});

// Что считать. Работнику видны только назначенные задания.
router.get('/tasks', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const statuses = req.query.status
      ? String(req.query.status).split(',').map((s) => s.trim())
      : ['pending'];
    const allowed = ['pending', 'matched', 'waiting_owner', 'applied', 'rejected'];
    if (statuses.some((s) => !allowed.includes(s))) {
      throw new HttpError(400, 'Неизвестное состояние задания');
    }
    // Работнику незачем видеть чужие решения: его дело — что посчитать.
    if (req.auth.role === 'worker' && statuses.some((s) => s !== 'pending')) {
      throw new HttpError(403, 'Работнику доступны только назначенные задания');
    }
    const tasks = await withTenantContext({ warehouseId }, (c) => (
      service.listTasks(c, warehouseId, statuses)
    ));
    res.json(tasks);
  } catch (err) { next(err); }
});

// Открыть ячейку: запоминается снимок, относительно которого будет считаться
// расхождение.
router.post('/tasks/:id/open', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (c) => (
      service.openTask(c, warehouseId, req.params.id)
    ));
    res.json(out);
  } catch (err) { next(err); }
});

router.post('/tasks/:id/count', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (c) => (
      service.submitCount(c, warehouseId, req.params.id, {
        lines: req.body.lines, note: req.body.note, workerKeyId: staffKeyId || null,
      })
    ));
    res.json(out);
  } catch (err) { next(err); }
});

// Решение по расхождению. Только владелец и только здесь остаток меняется.
router.post('/tasks/:id/resolve', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId, ownerId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (c) => (
      service.resolveTask(c, warehouseId, req.params.id, {
        decision: req.body.decision, ownerId,
      })
    ));
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
