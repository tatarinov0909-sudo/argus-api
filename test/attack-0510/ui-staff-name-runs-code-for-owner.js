// Находка (экран, появилась 27.09, не 04.10 — найдена на переделанном экране
// «Сотрудники»): имя работника вставляется в код кнопки «Сделать менеджером».
// Апостроф в имени («О'Нил») ломает кнопку, а подобранное имя выполняет
// чужой код в кабинете руководителя, когда он нажимает эту кнопку. Имя
// работника может задать менеджер с правом «выдавать ключи работникам».
//
// Только экран: страницы — из argus-product, ответы API подделаны.
// Нужен ARGUS_PLAYWRIGHT_MODULE и Chrome или Edge.
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const fs = require('node:fs');
const path = require('node:path');

const SITE = path.resolve(__dirname, '../../../argus-product');
const ORIGIN = 'http://argus.test';
function verdicts(title) {
  const bad = []; let good = 0;
  return {
    expect(label, isOk, expected, got) {
      if (isOk) { good += 1; console.log(`  ok    ${label}`); return; }
      bad.push(label); console.log(`  FAIL  ${label}\n        ожидалось: ${expected}\n        получили:  ${got}`);
    },
    done() { console.log(`\n${title}: ${good} выдержало, ${bad.length} нарушений`); if (bad.length && process.exitCode !== 2) process.exitCode = 1; },
  };
}

(async () => {
  const v = verdicts('Имя работника в кнопке «Сделать менеджером»');
  const { chromium } = require(process.env.ARGUS_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20000);
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.addInitScript((t) => { localStorage.setItem('argus_role', 'owner'); localStorage.setItem('argus_token', t); },
      `x.${Buffer.from(JSON.stringify({ role: 'owner', warehouseId: 'fixture', ownerId: 'fixture', exp: 4102444800 })).toString('base64url')}.x`);
    const staff = [
      { id: 'w-apostrophe', name: "Шон О'Нил", kind: 'worker', active: true, key_code: 'DEMO-01-AAAA', issued_at: '2026-10-01' },
      { id: 'w-crafted', name: "Ли'); window.__argusXss = 1; ('", kind: 'worker', active: true, key_code: 'DEMO-02-BBBB', issued_at: '2026-10-01' },
    ];
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url()); const p = u.pathname;
      if (u.origin === ORIGIN) {
        const f = path.join(SITE, decodeURIComponent(p));
        return fs.existsSync(f) ? route.fulfill({ path: f }) : route.fulfill({ status: 404, body: '' });
      }
      if (u.origin !== 'https://api.argus-ai.online') return route.abort();
      let data = [];
      if (p === '/api/leads/manage/access') return route.fulfill({ status: 403, json: { error: 'fixture' } });
      if (p === '/api/warehouses/me') data = { name: 'Тестовый склад', timezone: 'Europe/Moscow', stock_source: 'argus', setup_at: '2001-01-01' };
      if (p === '/api/warehouses/me/readiness') data = { steps: [] };
      if (p === '/api/alerts/today') data = { ship: {}, receive: {}, decide: {}, exchange: { sync: [] } };
      if (p === '/api/alerts') data = { alerts: [] };
      if (p === '/api/inventory/advice' || p === '/api/inventory/settings') data = { reasons: [] };
      if (p === '/api/sellers/stock-summary') data = { sellers: [] };
      if (p === '/api/sync/status') data = {};
      if (p === '/api/staff') data = staff;
      return route.fulfill({ json: data });
    });
    await page.goto(`${ORIGIN}/cabinet_main.html`);
    await page.locator('#view-home.active').waitFor();
    await page.locator('#nav-staff').click();
    await page.getByText("Шон О'Нил", { exact: true }).waitFor();
    const promote = (name) => page.locator('.staff-row', { hasText: name }).locator('button', { hasText: 'Сделать менеджером' });

    // 1. Апостроф в имени: кнопка должна открыть подтверждение.
    const before = pageErrors.length;
    await promote("Шон О'Нил").click();
    await page.waitForTimeout(500);
    const asked = await page.getByText("Сделать «Шон О'Нил» менеджером?").isVisible().catch(() => false);
    v.expect("«Сделать менеджером» у «Шон О'Нил» работает", pageErrors.length === before && asked,
      "открылось подтверждение «Сделать «Шон О'Нил» менеджером?», ошибок нет",
      `ошибка страницы: ${pageErrors.slice(before).join('; ') || 'нет'}; подтверждение ${asked ? 'открылось' : 'не открылось'}`);
    await page.keyboard.press('Escape');
    await page.reload(); await page.locator('#view-home.active').waitFor();
    await page.locator('#nav-staff').click(); await page.getByText("Шон О'Нил", { exact: true }).waitFor();

    // 2. Подобранное имя: нажатие руководителя не должно выполнять код из имени.
    await promote('window.__argusXss').click();
    await page.waitForTimeout(500);
    const ran = await page.evaluate(() => window.__argusXss === 1);
    v.expect('код из имени работника не выполняется', !ran, 'window.__argusXss не задан', 'код из имени выполнился в кабинете руководителя');
    await page.close();
  } catch (err) { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; } finally { await browser.close(); v.done(); }
})();
