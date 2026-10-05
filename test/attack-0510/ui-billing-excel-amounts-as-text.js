// Находка (экран): в «Расчётах» руководителя «Выгрузить в Excel» и
// «Выгрузить счёт в Excel» пишут цены и суммы текстом («124690.56» с точкой),
// а не числами. В русском Excel такие ячейки не складываются и не
// превращаются в числа сами — бухгалтер перепечатывает. У клиента в его
// кабинете та же выгрузка числовая (seller-cabinet.js, money: true).
//
// Только экран: страницы — из argus-product, ответы API подделаны; SheetJS —
// с публичного cdnjs, как у самого кабинета. Нужен ARGUS_PLAYWRIGHT_MODULE.
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const fs = require('node:fs');
const path = require('node:path');

const SITE = path.resolve(__dirname, '../../../argus-product');
const ORIGIN = 'https://argus.test'; // https: кабинет пользуется crypto.randomUUID (только в защищённом контексте)
const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
// Ответы — в том виде, в каком их отдаёт src/billing/service.js.
const prices = { receiving: '1.01', picking: '10.00', returns: '3.00', storage: '2.00' };
const line = { service: 'receiving', title: 'Приёмка', tariffId: 't1', effectiveFrom: '2026-09-01', missingTariff: false, unit: 'шт.',
  rate: '1.01', qty: 56, details: [{ label: 'ПР-0901-01', day: '2026-09-03', documentId: null, qty: 56 }], amount: '56.56', amountCents: '5656' };
const invoice = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', number: 'СЧ-BBBBBBBB', companyId: COMPANY, companyName: 'Тестовый клиент',
  from: '2026-09-01', to: '2026-09-30', issuedAt: '2026-10-01T09:00:00Z', dueDate: '2026-10-08', lines: [line], total: '56.56', totalCents: '5656',
  paid: '0.00', paidCents: '0', balance: '56.56', balanceCents: '5656', status: 'unpaid', payments: [] };

(async () => {
  const v = verdicts('Выгрузка расчётов в Excel: суммы');
  const { chromium } = require(process.env.ARGUS_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
  let xlsx;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    page.setDefaultTimeout(20000);
    await page.addInitScript((t) => { localStorage.setItem('argus_role', 'owner'); localStorage.setItem('argus_token', t); },
      `x.${Buffer.from(JSON.stringify({ role: 'owner', warehouseId: 'fixture', ownerId: 'fixture', exp: 4102444800 })).toString('base64url')}.x`);
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url()); const p = u.pathname;
      if (u.origin === ORIGIN) {
        const f = path.join(SITE, decodeURIComponent(p));
        return fs.existsSync(f) ? route.fulfill({ path: f }) : route.fulfill({ status: 404, body: '' });
      }
      if (u.hostname === 'cdnjs.cloudflare.com' && p === '/ajax/libs/xlsx/0.18.5/xlsx.full.min.js') {
        if (!xlsx) xlsx = route.fetch().then(async (r) => ({ status: r.status(), headers: r.headers(), body: await r.body() }));
        return route.fulfill(await xlsx);
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
      if (p === '/api/sellers/companies') data = [{ id: COMPANY, name: 'Тестовый клиент', keys: [] }];
      if (p === '/api/warehouses/billing/charges') data = { from: u.searchParams.get('from'), to: u.searchParams.get('to'), approximate: false,
        missingTariff: false, sellers: [{ companyId: COMPANY, name: 'Тестовый клиент', configured: true, missingTariff: false, lines: [line], total: '56.56', totalCents: '5656' }],
        total: '56.56', totalCents: '5656' };
      if (p === '/api/warehouses/billing/tariff') data = { companyId: COMPANY, configured: true, prices, storageUnit: 'cell_day', effectiveFrom: '2026-09-01',
        showSellers: true, approximate: false, history: [{ id: 't1', prices, storageUnit: 'cell_day', effectiveFrom: '2026-09-01' }] };
      if (p === '/api/warehouses/billing/schedule') data = { showSellers: true, enabled: false, cadence: 'monthly', intervalDays: 30, startDate: null, nextStart: null, paymentDays: 7 };
      if (p === '/api/warehouses/billing/invoices') data = { items: [invoice], nextCursor: null };
      return route.fulfill({ json: data });
    });
    await page.goto(`${ORIGIN}/cabinet_main.html`);
    await page.locator('#view-home.active').waitFor();
    await page.waitForFunction(() => !!window.XLSX);
    await page.locator('#nav-billing').click();
    await page.locator(`.finance-client-button[data-bill-company="${COMPANY}"]`).click();
    await page.locator('#billIssue').waitFor();

    // Скачанный файл разбираем той же SheetJS в браузере: тип ячейки «n» — число, «s» — текст.
    const cells = async (click) => {
      const [download] = await Promise.all([page.waitForEvent('download'), click()]);
      const bytes = [...fs.readFileSync(await download.path())];
      return page.evaluate((b) => {
        const book = XLSX.read(new Uint8Array(b), { type: 'array' }); const ws = book.Sheets[book.SheetNames[0]];
        const range = XLSX.utils.decode_range(ws['!ref']); const head = {};
        for (let c = range.s.c; c <= range.e.c; c += 1) head[ws[XLSX.utils.encode_cell({ r: range.s.r, c })]?.v] = c;
        const at = (name) => { const cell = ws[XLSX.utils.encode_cell({ r: range.s.r + 1, c: head[name] })]; return cell ? { t: cell.t, v: cell.v } : null; };
        return { rate: at('Цена, ₽'), amount: at('Сумма, ₽') };
      }, bytes);
    };
    const preview = await cells(() => page.getByRole('button', { name: 'Выгрузить в Excel' }).click());
    v.expect('начисления: «Сумма, ₽» — число', preview.amount?.t === 'n', 'число 56.56', `${preview.amount?.t === 's' ? 'текст' : preview.amount?.t} «${preview.amount?.v}»`);
    v.expect('начисления: «Цена, ₽» — число', preview.rate?.t === 'n', 'число 1.01', `${preview.rate?.t === 's' ? 'текст' : preview.rate?.t} «${preview.rate?.v}»`);
    await page.locator(`details[data-invoice="${invoice.id}"] > summary`).click();
    const bill = await cells(() => page.locator(`[data-export-invoice="${invoice.id}"]`).click());
    v.expect('счёт: «Сумма, ₽» — число', bill.amount?.t === 'n', 'число 56.56', `${bill.amount?.t === 's' ? 'текст' : bill.amount?.t} «${bill.amount?.v}»`);
    await page.close();
  } catch (err) { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; } finally { await browser.close(); v.done(); }
})();
