// Экранные проверки 07.10: страницы из argus-product, ответы API — подделка
// в тесте, наружу — никуда (XLSX подменяется заглушкой, которая запоминает
// выгружаемые строки). Как tests/product-picker-ui.cjs.
const fs = require('node:fs');
const path = require('node:path');

const SITE = path.resolve(__dirname, '../../../argus-product');
const ORIGIN = 'https://site.invalid';
const API = 'https://api.argus-ai.online';
const token = (claims) => 'x.' + Buffer.from(JSON.stringify({ exp: 4102444800, iat: 1700000000, ...claims })).toString('base64url') + '.x';

// Обязательные ответы кабинета склада — иначе он не дорисуется.
function ownerDefaults(p) {
  if (p === '/api/leads/manage/access') return { status: 403, json: { error: 'fixture' } };
  if (p === '/api/warehouses/me') return { json: { name: 'Тестовый склад', timezone: 'Europe/Moscow', stock_source: '1c', setup_at: '2001-01-01', address_storage: true } };
  if (p === '/api/warehouses/me/readiness') return { json: { steps: [] } };
  if (p === '/api/sellers/stock-summary') return { json: { source: '1c', sellers: [] } };
  if (p === '/api/alerts/today') return { json: { ship: {}, receive: {}, decide: {}, exchange: { sync: [] } } };
  if (p === '/api/alerts') return { json: { alerts: [] } };
  if (p === '/api/inventory/advice' || p === '/api/inventory/settings') return { json: { reasons: [] } };
  if (p === '/api/sync/status') return { json: {} };
  return null;
}

async function launch() {
  const { chromium } = require(process.env.ARGUS_PLAYWRIGHT_MODULE || 'playwright');
  return chromium.launch({ headless: true, channel: process.env.ARGUS_BROWSER_CHANNEL || 'msedge' });
}

// api(path, url, request) → { json, status } | данные | undefined (тогда []).
async function open(browser, { file = 'cabinet_main.html', role = 'owner', claims = {}, width = 1440, height = 900, api = () => undefined }) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(15000);
  const calls = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(([t, r]) => {
    localStorage.setItem('argus_role', r); localStorage.setItem('argus_token', t);
    window.__xlsx = [];
    // Заглушка XLSX: что выгружается — запоминаем, файл не пишем.
    const stub = { utils: {
      json_to_sheet: (rows) => { window.__xlsx.push(rows); return {}; },
      aoa_to_sheet: (rows) => { window.__xlsx.push(rows); return {}; },
      book_new: () => ({}), book_append_sheet: () => {}, encode_cell: () => 'A1', decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }),
    }, writeFile: () => {} };
    Object.defineProperty(window, 'XLSX', { get: () => stub, set: () => {}, configurable: true });
  }, [token({ role, warehouseId: 'fixture', ownerId: 'fixture', ...claims }), role]);
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin === ORIGIN) {
      const local = path.resolve(SITE, '.' + decodeURIComponent(u.pathname));
      return local.startsWith(SITE + path.sep) && fs.existsSync(local) ? route.fulfill({ path: local }) : route.fulfill({ status: 404, body: '' });
    }
    if (u.origin !== API) return route.abort();
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ path: u.pathname, method: req.method(), body, query: Object.fromEntries(u.searchParams) });
    const own = await api(u.pathname, u, req, body);
    const out = own !== undefined ? own : (role === 'owner' || role === 'manager' ? ownerDefaults(u.pathname) : null);
    if (out && (out.json !== undefined || out.status)) return route.fulfill({ status: out.status || 200, json: out.json === undefined ? {} : out.json });
    return route.fulfill({ json: out == null ? [] : out });
  });
  await page.goto(ORIGIN + '/' + file);
  return { page, calls, errors };
}

module.exports = { launch, open, token, ORIGIN };
