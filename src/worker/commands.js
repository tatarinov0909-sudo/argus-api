const { createHash } = require('node:crypto');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const qr = require('./cellQr');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIVING = 'POST /api/receiving';
const PLACE = 'POST /api/receiving/items/:invoiceItemId/place';
const PAUSE = 'POST /api/journal/pause';
const OFFLINE = [RECEIVING, PLACE, PAUSE];
const IDEMPOTENT = [
  RECEIVING, PLACE, PAUSE,
  ...['defect', 'move', 'remove'].map((verb) => `POST /api/receiving/items/:invoiceItemId/${verb}`),
  ...['start', 'abandon', 'finish'].map((verb) => `POST /api/receiving/session/:invoiceId/${verb}`),
  'POST /api/shipping', 'POST /api/shipping/product', 'POST /api/shipping/missing',
  ...['start', 'abandon', 'finish'].map((verb) => `POST /api/shipping/assembly/:supplyId/${verb}`),
  'POST /api/shipping/paper/start', 'POST /api/shipping/paper/finish',
  'POST /api/returns', 'POST /api/cells/move', 'POST /api/defects/moves', 'POST /api/defects/tasks/:id/done',
];
const descriptor = (operation) => { const [method, path] = operation.split(' '); return { method, path }; };
const capabilities = {
  offline: { version: 1, supportedOperations: OFFLINE.map(descriptor), idempotentOperations: IDEMPOTENT.map(descriptor),
    operationIdHeader: 'X-Argus-Operation-Id', offlineHeader: 'X-Argus-Offline', maxPendingStockCommands: 1 },
  cellQr: { version: 1, prefix: qr.PREFIX },
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const operationOf = (req) => `${req.method} ${(req.baseUrl + req.route.path).replace(/\/$/, '')}`;
const conflict = (code, message, extra = {}) => new HttpError(409, message, { code, ...extra });

async function receivingGuard(client, req, operation, offline) {
  const b = req.body || {}, { warehouseId, staffKeyId } = req.auth;
  if (!b.workSessionId && !offline && !b.cellQr && !b.expected && !b.placements?.some((p) => p.cellQr) && !b.defect?.cellQr) return;
  // Keep the addressing mode stable until this scanned placement commits.
  const warehouse = (await client.query('SELECT address_storage FROM warehouses WHERE id = $1 FOR SHARE', [warehouseId])).rows[0];
  const itemId = req.params.invoiceItemId || b.invoiceItemId;
  const item = (await client.query(
    `SELECT ii.id, ii.invoice_id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE ii.id = $1 AND ii.warehouse_id = $2 AND i.direction = 'in' FOR UPDATE OF i`, [itemId, warehouseId],
  )).rows[0];
  if (!item) throw new HttpError(404, 'Позиция приёмки не найдена');
  if (!UUID.test(String(b.workSessionId || ''))) throw new HttpError(400, 'Нужен номер захода приёмки', { code: 'work_session_required' });
  const session = (await client.query(
    `SELECT id, started_at, last_event_at FROM work_sessions WHERE id = $1 AND warehouse_id = $2 AND invoice_id = $3
      AND worker_key_id = $4 AND status = 'active' FOR UPDATE`, [b.workSessionId, warehouseId, item.invoice_id, staffKeyId],
  )).rows[0];
  if (!session) throw conflict('work_session_changed', 'Работу уже завершили, передали или поставили на паузу — откройте приёмку');
  let occurredAt = null;
  if (offline || b.occurredAt != null) {
    const timestamp = typeof b.occurredAt === 'string' ? Date.parse(b.occurredAt) : NaN;
    if (!Number.isFinite(timestamp) || timestamp < new Date(session.last_event_at || session.started_at).getTime() || timestamp > Date.now() + 60000) {
      throw conflict('work_event_time', 'Время подтверждения не совпадает с текущим заходом работы');
    }
    occurredAt = new Date(Math.min(timestamp, Date.now())).toISOString();
  }
  const state = (await client.query(
    `SELECT rr.id, rr.accepted_qty - COALESCE((SELECT SUM(rp.qty) FROM receiving_placements rp WHERE rp.receiving_record_id = rr.id), 0) AS unplaced
       FROM receiving_records rr WHERE rr.invoice_item_id = $1`, [itemId],
  )).rows[0];
  if (operation === RECEIVING) {
    if (offline && b.expected?.received !== false) throw new HttpError(400, 'Нужен исходный статус приёмки', { code: 'expected_state_required' });
    if (b.expected?.received === false && state) throw conflict('receiving_changed', 'Позицию уже приняли — сверьте сохранённое действие');
  } else {
    if (offline && (!Number.isSafeInteger(b.expected?.unplacedQty) || b.expected.unplacedQty < 0)) {
      throw new HttpError(400, 'Нужно исходное количество неразложенного', { code: 'expected_state_required' });
    }
    if (b.expected?.unplacedQty != null && (!state || Number(state.unplaced) !== b.expected.unplacedQty)) {
      throw conflict('placement_changed', 'Раскладка изменилась — сверьте сохранённое действие', { unplacedQty: state ? Number(state.unplaced) : null });
    }
  }
  const placements = operation === PLACE ? [b] : [...(b.placements || (b.cellBlockId ? [b] : []))];
  if (b.defect) placements.push(b.defect);
  for (const place of placements) {
    if (offline && !place.cellQr) throw new HttpError(400, 'Для работы без связи отсканируйте QR ячейки', { code: 'cell_scan_required' });
    if (place.cellQr) await qr.verify(client, warehouseId, place.cellQr, place.cellBlockId);
    if (warehouse?.address_storage === false) {
      const general = (await client.query('SELECT id FROM cell_blocks WHERE warehouse_id = $1 AND general', [warehouseId])).rows[0];
      if (!general || general.id !== String(place.cellBlockId).toLowerCase()) {
        throw conflict('addressing_changed', 'Адресное хранение выключено — сверьте сохранённую раскладку');
      }
    }
  }
  return { sessionId: session.id, workerKeyId: staffKeyId, occurredAt };
}

// The command and its stock movement commit together. A failed transaction leaves
// neither behind; a lost response can replay the committed result, even after finish.
async function withWorkerCommand(req, fn) {
  const operation = operationOf(req), id = req.get('X-Argus-Operation-Id');
  const offline = req.get('X-Argus-Offline') === '1';
  const { warehouseId, staffKeyId } = req.auth;
  if (!id) {
    if (offline) throw new HttpError(400, 'Нужен номер сохранённого действия', { code: 'operation_id_required' });
    return withTenantContext({ warehouseId }, fn);
  }
  if (req.auth.role !== 'worker' || !IDEMPOTENT.includes(operation)) throw new HttpError(400, 'Повтор этого действия пока не поддерживается');
  if (!UUID.test(id)) throw new HttpError(400, 'Некорректный номер действия', { code: 'invalid_operation_id' });
  if (offline && !OFFLINE.includes(operation)) throw new HttpError(409, 'Для этого действия нужна связь', { code: 'offline_not_supported' });
  const hash = createHash('sha256').update(JSON.stringify(canonical({ operation, params: req.params, body: req.body || {}, offline }))).digest('hex');
  return withTenantContext({ warehouseId }, async (client) => {
    const inserted = (await client.query(
      `INSERT INTO worker_commands (warehouse_id, operation_id, worker_key_id, operation, payload_hash)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING operation_id`, [warehouseId, id, staffKeyId, operation, hash],
    )).rows[0];
    if (!inserted) {
      const prior = (await client.query('SELECT worker_key_id, payload_hash, result FROM worker_commands WHERE warehouse_id = $1 AND operation_id = $2 FOR UPDATE', [warehouseId, id])).rows[0];
      if (!prior || prior.worker_key_id !== staffKeyId || prior.payload_hash !== hash) throw conflict('operation_changed', 'Номер действия уже использован — сверьте сохранённые данные');
      if (prior.result === null) throw conflict('operation_pending', 'Действие ещё выполняется — повторите с тем же номером');
      req.res?.set('X-Argus-Operation-Replayed', '1');
      return prior.result;
    }
    if ([RECEIVING, PLACE].includes(operation)) req.workerCommand = await receivingGuard(client, req, operation, offline);
    if (operation === PAUSE && (offline || req.body?.workSessionId)) {
      if (!UUID.test(String(req.body?.workSessionId || ''))) throw new HttpError(400, 'Нужен номер захода работы', { code: 'work_session_required' });
      if (!Number.isSafeInteger(req.body.eventSequence) || req.body.eventSequence < 1 || typeof req.body.eventAt !== 'string' || !Number.isFinite(Date.parse(req.body.eventAt))) {
        throw new HttpError(400, 'Нужны время и порядковый номер события паузы', { code: 'invalid_pause_event' });
      }
    }
    let result;
    try {
      result = await fn(client);
    } catch (err) {
      // Only a fresh command's business error is known to roll back. Never label
      // prior-ID conflicts, auth failures or an uncertain COMMIT/network error.
      if (err instanceof HttpError && [400, 409].includes(err.status) && !err.details?.code) {
        err.details = { ...(err.details || {}), code: 'worker_command_rejected' };
      }
      throw err;
    }
    if (result == null) throw new Error('Worker command must return an acknowledgement');
    const occurredAt = req.workerCommand?.occurredAt;
    if (occurredAt) {
      await client.query("UPDATE work_sessions SET last_event_at = $2 WHERE id = $1 AND status = 'active'", [req.workerCommand.sessionId, occurredAt]);
    }
    await client.query('UPDATE worker_commands SET result = $3::jsonb, occurred_at = $4 WHERE warehouse_id = $1 AND operation_id = $2',
      [warehouseId, id, JSON.stringify(result), occurredAt || (operation === PAUSE ? req.body.eventAt || null : null)]);
    return result;
  });
}

module.exports = { withWorkerCommand, capabilities, canonical };
