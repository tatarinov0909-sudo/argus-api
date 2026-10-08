// Экранные проверки 08.10: страницы — из своей копии сайта (wt-product), ответы
// API — подделка в тесте, наружу — никуда. По образцу attack-0710/_ui.js, но
// вход кладётся на место своей роли (auth.js, argus_auth_<роль>).
const fs = require('node:fs');
const path = require('node:path');

const SITE = path.resolve('C:/Users/tatar/Desktop/argus-handoff/wt-product');
const ORIGIN = 'https://site.invalid';
const API = 'https://api.argus-ai.online';
const token = (claims) => 'x.' + Buffer.from(JSON.stringify({ exp: 4102444800, iat: 1700000000, ...claims })).toString('base64url') + '.x';
const claimsOf = (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return null; } };

async function launch() {
  const { chromium } = require(process.env.ARGUS_PLAYWRIGHT_MODULE || 'playwright');
  return chromium.launch({ headless: true, channel: process.env.ARGUS_BROWSER_CHANNEL || 'msedge' });
}

// init — localStorage до первой страницы (один раз на контекст);
// api(path, url, request, body) → { json, status } | данные | undefined.
async function context(browser, { width = 1440, height = 900, init = {}, api = () => undefined }) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript((seed) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
  }, init);
  const calls = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin === ORIGIN) {
      const local = path.resolve(SITE, '.' + decodeURIComponent(u.pathname));
      return local.startsWith(SITE + path.sep) && fs.existsSync(local) ? route.fulfill({ path: local }) : route.fulfill({ status: 404, body: '' });
    }
    if (u.origin !== API) return route.abort();
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ path: u.pathname, method: req.method(), body });
    const out = await api(u.pathname, u, req, body);
    if (out && (out.json !== undefined || out.status)) return route.fulfill({ status: out.status || 200, json: out.json === undefined ? {} : out.json });
    return route.fulfill({ json: out == null ? [] : out });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, calls, errors };
}

module.exports = { launch, context, token, claimsOf, ORIGIN, SITE };
