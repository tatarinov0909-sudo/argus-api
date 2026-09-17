const express = require('express');
const { withoutTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
router.use('/manage', require('./manage'));

// Заявка с лендинга — единственная ручка без авторизации.
//
// Это граница доверия: сюда пишет кто угодно из интернета. Поэтому здесь
// больше проверок, чем в остальном коде, и ни одно поле не попадает в базу
// в том виде, в каком пришло.

const LIMITS = { name: 200, contact: 200, message: 4000, field: 500, fields: 20 };

// Не больше пяти заявок в час с одного адреса — тем же счётчиком, что и
// у входов (middleware/rateLimit.js). Своя копия этого счётчика жила здесь
// и делала ровно то же самое.
const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  key: (req) => req.ip || req.socket?.remoteAddress || null,
  message: 'Слишком много заявок подряд — попробуйте позже',
});

const trim = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);

router.post('/', leadLimiter, async (req, res, next) => {
  try {
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
