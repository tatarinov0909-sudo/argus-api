const express = require('express');
const { requireAuth, requireRole, requireGrant } = require('../middleware/auth');
const { withTenantContext, withoutTenantContext } = require('../db/pool');
const { keyLoginLimiter } = require('../middleware/rateLimit');
const { HttpError } = require('../middleware/errorHandler');
const service = require('./service');
const outbox = require('./outbox');
const { recordBatch } = require('./health');

const router = express.Router();

const MAX_BATCH = 500;

function requireBatch(body) {
  const records = body?.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new HttpError(400, 'Ожидался непустой массив records');
  }
  if (records.length > MAX_BATCH) {
    throw new HttpError(413, `За один раз можно передать не больше ${MAX_BATCH} записей`);
  }
  if (records.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new HttpError(400, 'Каждая запись records должна быть объектом');
  }
  return records;
}

/* ===================== Owner: managing the integration key ===================== */

router.get('/keys', requireAuth, requireGrant('integration'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `SELECT id, key_code, label, active, issued_at, revoked_at, last_seen_at
         FROM integration_keys WHERE warehouse_id = $1 ORDER BY issued_at DESC`,
        [warehouseId],
      );
      return result.rows;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/keys', requireAuth, requireGrant('integration'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { label } = req.body || {};

    const key = await withTenantContext({ warehouseId }, async (client) => {
      const wh = await client.query(
        `SELECT warehouse_code FROM warehouses WHERE id = $1`, [warehouseId],
      );
      if (!wh.rows[0]) throw new HttpError(404, 'Склад не найден');

      // key_code is globally unique; retry on the astronomically unlikely clash
      // rather than letting a 500 reach the owner.
      for (let attempt = 0; attempt < 5; attempt++) {
        const keyCode = service.generateKeyCode(wh.rows[0].warehouse_code);
        try {
          const result = await client.query(
            `INSERT INTO integration_keys (warehouse_id, key_code, label)
             VALUES ($1, $2, $3)
             RETURNING id, key_code, label, active, issued_at`,
            [warehouseId, keyCode, label?.trim() || null],
          );
          return result.rows[0];
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
      }
      throw new HttpError(500, 'Не удалось сгенерировать ключ, попробуйте ещё раз');
    });
    res.status(201).json(key);
  } catch (err) {
    next(err);
  }
});

router.patch('/keys/:id/toggle', requireAuth, requireGrant('integration'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { id } = req.params;
    const key = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `UPDATE integration_keys
         SET active = NOT active,
             revoked_at = CASE WHEN active THEN now() ELSE NULL END
         WHERE id = $1 AND warehouse_id = $2
         RETURNING id, key_code, label, active, issued_at, revoked_at, last_seen_at`,
        [id, warehouseId],
      );
      return result.rows[0] || null;
    });
    if (!key) throw new HttpError(404, 'Ключ не найден');
    res.json(key);
  } catch (err) {
    next(err);
  }
});

// Owner-facing health view: is 1C still talking to us, and how far behind is it.
router.get('/status', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const status = await withTenantContext({ warehouseId }, async (client) => {
      const pending = await outbox.pendingCount(client, warehouseId);
      const lastSeen = await client.query(
        `SELECT MAX(last_seen_at) AS last_seen FROM integration_keys
         WHERE warehouse_id = $1 AND active = true`,
        [warehouseId],
      );
      const counts = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM products p JOIN companies c ON c.id=p.company_id AND c.archived_at IS NULL
             WHERE p.warehouse_id = $1 AND p.external_id IS NOT NULL) AS synced_products,
           (SELECT COUNT(*)::int FROM companies
             WHERE warehouse_id = $1 AND external_id IS NOT NULL AND archived_at IS NULL) AS synced_companies,
           (SELECT COUNT(*)::int FROM invoices i JOIN companies c ON c.id=i.company_id AND c.archived_at IS NULL
             WHERE i.warehouse_id = $1 AND i.source = '1c' AND i.external_id IS NOT NULL) AS synced_invoices,
           (SELECT COUNT(*)::int FROM products p
             LEFT JOIN companies c ON c.id = p.company_id AND c.archived_at IS NULL
            WHERE p.warehouse_id = $1 AND p.external_id IS NOT NULL
              AND (p.company_id IS NULL OR (c.id IS NOT NULL AND c.external_id IS NULL))) AS unassigned_products,
           (SELECT COUNT(*)::int FROM integration_counterparties ic
             WHERE ic.warehouse_id = $1 AND NOT EXISTS (
               SELECT 1 FROM companies c
                WHERE c.warehouse_id = ic.warehouse_id AND c.external_id = ic.external_id
                  AND c.archived_at IS NULL
             )) AS unmapped_counterparties`,
        [warehouseId],
      );
      const batches = await client.query(`SELECT s.stage, s.received_at, s.module_version,
          s.run_mode, s.record_count, s.summary, s.stock_calculation, s.stock_calculation_status
        FROM integration_sync_state s
        JOIN integration_keys k ON k.id = s.integration_key_id AND k.active
        WHERE s.warehouse_id = $1 ORDER BY s.received_at DESC, s.stage`, [warehouseId]);
      return {
        pendingEvents: pending,
        lastSeenAt: lastSeen.rows[0].last_seen,
        pushStages: batches.rows,
        ...counts.rows[0],
      };
    });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/* ===================== 1C module: auth ===================== */

router.post('/auth', keyLoginLimiter, async (req, res, next) => {
  try {
    const { keyCode } = req.body || {};
    if (!keyCode || typeof keyCode !== 'string') throw new HttpError(400, 'Введите ключ интеграции');
    const normalized = keyCode.trim().toUpperCase();

    const result = await withoutTenantContext(async (client) => {
      // RLS-protected table looked up before its own scope is known — same
      // SECURITY DEFINER pattern as the staff and seller key logins.
      const found = await client.query(
        `SELECT * FROM find_integration_key_for_login($1)`, [normalized],
      );
      const key = found.rows[0];
      if (!key) throw new HttpError(404, 'Ключ интеграции не найден');
      if (!key.active) throw new HttpError(403, 'Этот ключ интеграции отозван');
      return key;
    });

    await withTenantContext({ warehouseId: result.warehouse_id }, async (client) => {
      await client.query(
        `UPDATE integration_keys SET last_seen_at = now() WHERE id = $1`, [result.id],
      );
    });

    res.json({
      token: service.signIntegrationToken({
        warehouseId: result.warehouse_id, integrationKeyId: result.id,
      }),
      warehouseId: result.warehouse_id,
    });
  } catch (err) {
    next(err);
  }
});

/* ===================== 1C module: push ===================== */

// Отозванный ключ перестаёт работать на первом же запросе.
//
// Токен обмена живёт два часа, и всё это время отозванный ключ продолжал
// присылать данные: проверки активности для роли `integration` не было
// вовсе. Отметка «ключ выходил на связь» и есть эта проверка: ничего не
// обновилось — значит ключ отозван, и вся транзакция обмена откатывается.
async function touchIntegrationKey(client, integrationKeyId) {
  const r = await client.query(
    'UPDATE integration_keys SET last_seen_at = now() WHERE id = $1 AND active RETURNING id',
    [integrationKeyId],
  );
  if (!r.rows[0]) throw new HttpError(401, 'Ключ интеграции отозван. Получите новый ключ у владельца склада.');
}

// Одна дорога для всех push-ручек. `mappedCompany` — для номенклатуры и
// документов: они обязаны нести сопоставленного контрагента 1С или стабильный
// идентификатор товара, уже назначенного продавцу. Общий «контрагент по
// умолчанию» однажды увёл весь справочник выдуманному владельцу и здесь
// отвергается нарочно.
function pushHandler(upsertFn, { mappedCompany = false } = {}) {
  return async (req, res, next) => {
    try {
      const { warehouseId, integrationKeyId } = req.auth;
      const records = requireBatch(req.body);
      if (mappedCompany && req.body.defaultCompanyName != null) {
        throw new HttpError(400, 'defaultCompanyName больше не поддерживается; передайте companyExternalId в каждой записи');
      }

      const results = await withTenantContext({ warehouseId }, async (client) => {
        await touchIntegrationKey(client, integrationKeyId);
        const out = await upsertFn(client, warehouseId, records);
        await recordBatch(client, req, records, out);
        return out;
      });

      // Per-record outcomes, so a bad row in a 500-row batch is reported
      // precisely instead of failing everything around it.
      const summary = results.reduce((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {});
      res.json({ summary, results });
    } catch (err) {
      next(err);
    }
  };
}

const push = (fn, opts) => [requireAuth, requireRole('integration'), pushHandler(fn, opts)];
const mapped = { mappedCompany: true };

router.post('/push/companies', ...push(service.upsertCompanies));
router.post('/push/counterparties', ...push(service.upsertCounterparties));
router.post('/push/products', ...push(service.upsertProducts, mapped));
router.post('/push/invoices', ...push(service.upsertInvoices, mapped));
// Остатки: то, чего в обмене не было вовсе, из-за чего Аргус ничего не знал о
// складе по-настоящему.
router.post('/push/stock', ...push(service.upsertStock, mapped));
router.post('/push/cells', ...push(service.upsertCells1c, mapped));
router.post('/push/cell-catalog', ...push(service.upsertCellCatalog, mapped));

/* ===================== 1C module: pull + acknowledge ===================== */

router.get('/changes', requireAuth, requireRole('integration'), async (req, res, next) => {
  try {
    const { warehouseId, integrationKeyId } = req.auth;
    const since = Number(req.query.since ?? 0);
    const asked = Number(req.query.limit ?? 100);
    if (!Number.isSafeInteger(since) || since < 0) {
      throw new HttpError(400, 'Параметр since должен быть неотрицательным целым числом');
    }
    // Нечисловой или отрицательный limit раньше уезжал в SQL как NaN и ронял
    // запрос пятисоткой вместо понятного отказа.
    if (!Number.isSafeInteger(asked) || asked <= 0) {
      throw new HttpError(400, `Параметр limit должен быть целым числом от 1 до ${MAX_BATCH}`);
    }
    const limit = Math.min(asked, MAX_BATCH);

    const payload = await withTenantContext({ warehouseId }, async (client) => {
      await touchIntegrationKey(client, integrationKeyId);
      const events = await outbox.listSince(client, warehouseId, { since, limit });
      return {
        events,
        // The id to acknowledge and to pass as `since` next time. Null on an
        // empty page so the caller keeps its previous cursor.
        cursor: events.length ? Number(events[events.length - 1].id) : null,
        hasMore: events.length === limit,
      };
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.post('/changes/ack', requireAuth, requireRole('integration'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const upToId = Number(req.body?.upToId);
    // Точное подтверждение по списку номеров, если 1С его прислала: «всё до N»
    // может проштамповать строку, которая закоммитилась уже после выдачи и
    // никому не уезжала. Старый вызов с одним upToId продолжает работать —
    // рабочая обработка 1С менять ничего не обязана.
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : null;
    if ((!ids || ids.length === 0) && (!Number.isFinite(upToId) || upToId <= 0)) {
      throw new HttpError(400, 'Укажите upToId — идентификатор последнего обработанного события');
    }
    const acknowledged = await withTenantContext({ warehouseId }, async (client) => {
      await touchIntegrationKey(client, req.auth.integrationKeyId);
      return outbox.markDelivered(client, warehouseId, upToId, ids);
    });
    res.json({ acknowledged });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
