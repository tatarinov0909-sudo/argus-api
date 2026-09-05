const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext, withoutTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const service = require('./service');
const outbox = require('./outbox');

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
  return records;
}

/* ===================== Owner: managing the integration key ===================== */

router.get('/keys', requireAuth, requireRole('owner'), async (req, res, next) => {
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

router.post('/keys', requireAuth, requireRole('owner'), async (req, res, next) => {
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

router.patch('/keys/:id/toggle', requireAuth, requireRole('owner'), async (req, res, next) => {
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
           (SELECT COUNT(*)::int FROM products   WHERE warehouse_id = $1 AND external_id IS NOT NULL) AS synced_products,
           (SELECT COUNT(*)::int FROM companies  WHERE warehouse_id = $1 AND external_id IS NOT NULL) AS synced_companies,
           (SELECT COUNT(*)::int FROM invoices   WHERE warehouse_id = $1 AND external_id IS NOT NULL) AS synced_invoices`,
        [warehouseId],
      );
      return {
        pendingEvents: pending,
        lastSeenAt: lastSeen.rows[0].last_seen,
        ...counts.rows[0],
      };
    });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/* ===================== 1C module: auth ===================== */

router.post('/auth', async (req, res, next) => {
  try {
    const { keyCode } = req.body || {};
    if (!keyCode) throw new HttpError(400, 'Введите ключ интеграции');
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

function pushHandler(upsertFn) {
  return async (req, res, next) => {
    try {
      const { warehouseId, integrationKeyId } = req.auth;
      const records = requireBatch(req.body);

      const results = await withTenantContext({ warehouseId }, async (client) => {
        const out = await upsertFn(client, warehouseId, records);
        await client.query(
          `UPDATE integration_keys SET last_seen_at = now() WHERE id = $1`,
          [integrationKeyId],
        );
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

router.post('/push/companies', requireAuth, requireRole('integration'), pushHandler(service.upsertCompanies));

// Общий хелпер: базы без связи документа/номенклатуры с контрагентом
// (в частности старая УТ 10.3) шлют весь пуш под одну явно указанную
// владельцем компанию, а не по externalId на каждую запись.
async function resolveDefaultCompanyId(client, warehouseId, defaultCompanyName) {
  if (!defaultCompanyName) return null;
  const found = await client.query(
    `SELECT id FROM companies WHERE warehouse_id = $1 AND name = $2`,
    [warehouseId, defaultCompanyName],
  );
  if (!found.rows[0]) {
    throw new HttpError(400, `Компания "${defaultCompanyName}" не найдена в Аргусе — создайте её в кабинете сначала`);
  }
  return found.rows[0].id;
}

// Отдельно от pushHandler: и товары, и накладные могут нести пакетный
// defaultCompanyName — см. resolveDefaultCompanyId выше.
function pushHandlerWithDefaultCompany(upsertFn) {
  return async (req, res, next) => {
    try {
      const { warehouseId, integrationKeyId } = req.auth;
      const records = requireBatch(req.body);
      const defaultCompanyName = req.body.defaultCompanyName?.trim();

      const results = await withTenantContext({ warehouseId }, async (client) => {
        const defaultCompanyId = await resolveDefaultCompanyId(client, warehouseId, defaultCompanyName);
        const out = await upsertFn(client, warehouseId, records, { defaultCompanyId });
        await client.query(
          `UPDATE integration_keys SET last_seen_at = now() WHERE id = $1`,
          [integrationKeyId],
        );
        return out;
      });

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

router.post('/push/products', requireAuth, requireRole('integration'), pushHandlerWithDefaultCompany(service.upsertProducts));
router.post('/push/invoices', requireAuth, requireRole('integration'), pushHandlerWithDefaultCompany(service.upsertInvoices));
// Остатки: то, чего в обмене не было вовсе, из-за чего Аргус ничего не знал о
// складе по-настоящему.
router.post('/push/stock', requireAuth, requireRole('integration'), pushHandlerWithDefaultCompany(service.upsertStock));

/* ===================== 1C module: pull + acknowledge ===================== */

router.get('/changes', requireAuth, requireRole('integration'), async (req, res, next) => {
  try {
    const { warehouseId, integrationKeyId } = req.auth;
    const since = Number(req.query.since || 0);
    const limit = Math.min(Number(req.query.limit || 100), MAX_BATCH);
    if (!Number.isFinite(since) || since < 0) {
      throw new HttpError(400, 'Параметр since должен быть неотрицательным числом');
    }

    const payload = await withTenantContext({ warehouseId }, async (client) => {
      const events = await outbox.listSince(client, warehouseId, { since, limit });
      await client.query(
        `UPDATE integration_keys SET last_seen_at = now() WHERE id = $1`, [integrationKeyId],
      );
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
    if (!Number.isFinite(upToId) || upToId <= 0) {
      throw new HttpError(400, 'Укажите upToId — идентификатор последнего обработанного события');
    }
    const acknowledged = await withTenantContext({ warehouseId }, async (client) => (
      outbox.markDelivered(client, warehouseId, upToId)
    ));
    res.json({ acknowledged });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
