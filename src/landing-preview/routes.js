const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { rateLimit } = require('../middleware/rateLimit');

const BASE = '/landing-preview';
const COOKIE = 'argus_landing_preview';

function loginPage(message = '') {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Argus — вход в лендинг</title>
<style>*{box-sizing:border-box}body{margin:0;background:#151719;color:#f2f3f5;font:17px/1.5 system-ui,sans-serif;min-height:100svh;display:grid;place-items:center;padding:24px}main{width:100%;max-width:440px;background:#202326;border:1px solid #373b40;border-radius:22px;padding:32px}a{color:#a7cfc8;text-decoration:none}h1{font-size:32px;margin:24px 0 8px}p{color:#b9bfc5}label{display:block;margin-bottom:8px}input,button{width:100%;font:inherit;border-radius:10px;padding:13px 15px}input{background:#151719;color:#fff;border:1px solid #626970}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #9dd3c8;outline-offset:3px}button{margin-top:18px;border:0;background:#a7cfc8;color:#14231f;font-weight:650;cursor:pointer}.error{color:#ffb3ae;min-height:26px;margin:12px 0 0}</style>
<main><a href="https://argus-ai.online/login.html">← Выбор кабинета</a><h1>Лендинг</h1><p>Закрытый просмотр Argus</p><form method="post" action="${BASE}/login"><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128" autofocus><p class="error" role="alert">${message}</p><button type="submit">Открыть лендинг</button></form></main></html>`;
}

function createLandingPreviewRouter({
  passwordHash = process.env.LANDING_PREVIEW_PASSWORD_HASH,
  directory = path.resolve(__dirname, '../../private/landing-preview'),
  origin = 'https://api.argus-ai.online',
  secure = true,
} = {}) {
  const router = express.Router();
  // Separate from warehouse JWTs. A restart or password change ends preview sessions.
  const sessionKey = randomBytes(48);
  const cookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: BASE + '/' };
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10,
    key: req => `landing-preview:${req.ip}`, failuresOnly: true,
    message: 'Слишком много попыток. Повторите через 15 минут.' });

  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash || '')) {
      return res.status(503).type('html').send(loginPage('Доступ ещё не настроен.'));
    }
    next();
  });
  function page(res, status = 200, message = '') {
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    return res.status(status).type('html').send(loginPage(message));
  }
  router.get('/login', (req, res) => page(res));
  router.post('/login', express.urlencoded({ extended: false, limit: '1kb' }),
    (req, res, next) => {
      if (req.get('origin') !== origin) return page(res, 403, 'Откройте форму входа заново.');
      // Preserve the shared limiter, rendering its error in the password form.
      const json = res.json.bind(res);
      res.json = body => res.statusCode === 429 ? page(res, 429, body.error) : json(body);
      limiter(req, res, next);
    }, async (req, res, next) => {
      try {
        const password = req.body?.password;
        if (typeof password !== 'string' || Buffer.byteLength(password) > 72 ||
            !await bcrypt.compare(password, passwordHash)) return page(res, 401, 'Неверный пароль.');
        const token = jwt.sign({}, sessionKey, { algorithm: 'HS256', expiresIn: '8h',
          issuer: 'argus-landing-preview', audience: 'landing-preview' });
        res.cookie(COOKIE, token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 });
        return res.redirect(303, BASE + '/');
      } catch (error) { next(error); }
    });
  router.post('/logout', (req, res) => {
    if (req.get('origin') !== origin) return res.sendStatus(403);
    res.clearCookie(COOKIE, cookieOptions);
    res.redirect(303, BASE + '/login');
  });
  router.use((req, res, next) => {
    const value = (req.headers.cookie || '').split(';').map(s => s.trim())
      .find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    try {
      jwt.verify(value || '', sessionKey, { algorithms: ['HS256'],
        issuer: 'argus-landing-preview', audience: 'landing-preview' });
      return next();
    } catch {
      if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'))) {
        return res.redirect(303, BASE + '/login');
      }
      return res.sendStatus(401);
    }
  });
  router.use(express.static(directory, { index: 'landing.html', dotfiles: 'deny',
    etag: false, lastModified: false, cacheControl: false, redirect: false }));
  router.use((req, res) => res.sendStatus(404));
  return router;
}

module.exports = { createLandingPreviewRouter };
