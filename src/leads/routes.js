const express = require('express');
const { withoutTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');

const router = express.Router();

// Заявка с лендинга — единственная ручка без авторизации.
//
// Это граница доверия: сюда пишет кто угодно из интернета. Поэтому здесь
// больше проверок, чем в остальном коде, и ни одно поле не попадает в базу
// в том виде, в каком пришло.

const LIMITS = { name: 200, contact: 200, message: 4000, field: 500, fields: 20 };

// Простое ограничение частоты: с одного адреса не больше пяти заявок в час.
// В памяти процесса, а не в базе: перезапуск сбрасывает счётчик, и это
// приемлемо — задача не остановить злоумышленника, а не дать случайному
// скрипту залить таблицу за ночь.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const seen = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const hits = (seen.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) return true;
  hits.push(now);
  seen.set(ip, hits);
  // Карта не должна расти бесконечно: раз в сотню заявок чистим остывшее.
  if (seen.size > 500) {
    for (const [key, times] of seen) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) seen.delete(key);
    }
  }
  return false;
}

const trim = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);

router.post('/', async (req, res, next) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      throw new HttpError(429, 'Слишком много заявок подряд — попробуйте позже');
    }

    const body = req.body || {};
    const name = trim(body.name, LIMITS.name);
    const contact = trim(body.contact ?? body.phone ?? body.email, LIMITS.contact);
    const message = trim(body.message ?? body.comment, LIMITS.message);

    // Связаться не по чему — заявка бессмысленна, и лучше сказать об этом
    // человеку сразу, чем принять и молча потерять.
    if (!contact) throw new HttpError(400, 'Оставьте телефон или почту, иначе мы не ответим');

    // Остальные поля формы сохраняем как есть, но обрезанными и в ограниченном
    // количестве: форма меняется чаще схемы, а размер запроса — не их забота.
    const payload = {};
    for (const [key, value] of Object.entries(body)) {
      if (Object.keys(payload).length >= LIMITS.fields) break;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        payload[String(key).slice(0, 60)] = String(value).slice(0, LIMITS.field);
      }
    }

    await withoutTenantContext((client) => client.query(
      `INSERT INTO leads (name, contact, message, payload, source, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, contact, message, JSON.stringify(payload),
        trim(body.source, 60) || 'landing',
        trim(req.get('user-agent'), 300)],
    ));

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
