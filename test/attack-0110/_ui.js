// Проверка экранов сайта без сети и без базы: страницы argus-product
// отдаются с http://argus.test, ответы API — подделка в тесте (как в
// argus-product/tests/*.cjs). Нужен Playwright: ARGUS_PLAYWRIGHT_MODULE —
// путь к модулю, если он не установлен рядом; браузер — установленный Chrome.
const fs = require('node:fs');
const path = require('node:path');

// Рабочая копия сайта (argus-handoff/wt-product), а не папка Codex argus-product: та уходит вперёд и назад
// вместе с чужой работой. ARGUS_SITE — другая папка, если нужна.
const SITE = process.env.ARGUS_SITE || path.resolve(__dirname, '../../../argus-handoff/wt-product');
const type = (p) => (p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.js') ? 'text/javascript'
  : p.endsWith('.css') ? 'text/css' : p.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');

// Токен-заглушка: кабинеты читают из него роль и имя, подпись не проверяют.
const fakeToken = (claims) => `x.${Buffer.from(JSON.stringify({ exp: 4102444800, iat: 1700000000, ...claims })).toString('base64url')}.x`;

// apiData(pathname, url) → объект ответа или undefined (тогда — []).
async function openPage(page, { file, token, role, apiData }) {
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === 'http://argus.test') {
      const f = path.join(SITE, decodeURIComponent(u.pathname));
      if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ body: fs.readFileSync(f), contentType: type(u.pathname) });
    }
    if (u.origin !== 'https://api.argus-ai.online') return route.abort();
    const data = await apiData(u.pathname, u);
    return route.fulfill({ json: data === undefined ? [] : data });
  });
  await page.addInitScript(([t, r]) => { localStorage.setItem('argus_token', t); localStorage.setItem('argus_role', r); }, [token, role]);
  await page.goto(`http://argus.test/${file}`);
}

async function browser() {
  const { chromium } = require(process.env.ARGUS_PLAYWRIGHT_MODULE || 'playwright');
  return chromium.launch({ headless: true, channel: 'chrome' });
}

module.exports = { openPage, browser, fakeToken };
