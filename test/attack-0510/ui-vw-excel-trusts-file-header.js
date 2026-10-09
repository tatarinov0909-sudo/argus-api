// Находка (экран): Excel в «Добавить товары» читает столько строк, сколько
// записано в служебном заголовке файла (размер листа, <dimension>), а не
// сколько строк с данными на самом деле.
//  — Заголовок меньше данных (так пишут некоторые программы выгрузки):
//    часть товаров молча пропадает, экран пишет «Все строки проверены».
//  — Заголовок больше данных (в Excel отформатировали лишние строки):
//    файл из трёх строк отвергается как «больше 10 000 строк».
//
// Только экран: страницы — из argus-product, ответы API подделаны, запросов к
// настоящему API нет. Библиотека Excel (SheetJS) — с публичного cdnjs, как у
// самого кабинета. Нужен ARGUS_PLAYWRIGHT_MODULE и установленный Chrome или Edge.
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const fs = require('node:fs');
const path = require('node:path');
// Находка — список расхождений, как в test/attack-0310/_lib.js (тот модуль
// требует базу, а этому тесту база не нужна).
function verdicts(title) {
  const bad = []; let good = 0;
  return {
    expect(label, isOk, expected, got) {
      if (isOk) { good += 1; console.log(`  ok    ${label}`); return; }
      bad.push(label); console.log(`  FAIL  ${label}
        ожидалось: ${expected}
        получили:  ${got}`);
    },
    done() { console.log(`
${title}: ${good} выдержало, ${bad.length} нарушений`); if (bad.length && process.exitCode !== 2) process.exitCode = 1; },
  };
}

const SITE = process.env.ARGUS_SITE || path.resolve(__dirname, '../../../argus-handoff/wt-product');   // рабочая копия сайта, не папка Codex
const ORIGIN = 'http://argus.test';
const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET = '11111111-1111-4111-8111-111111111111';
const catalog = ['A-1', 'A-2', 'A-3', 'A-4'].map((sku) => ({ sku, name: `Товар ${sku}`, barcode: '', inCells: 10, toPick: 0, promised: 0, free: 10, inDestination: 0 }));

(async () => {
  const v = verdicts('Excel виртуального склада: строки файла');
  const { chromium } = require(process.env.ARGUS_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
  let xlsx;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20000);
    await page.addInitScript((t) => { localStorage.setItem('argus_role', 'owner'); localStorage.setItem('argus_token', t); },
      `x.${Buffer.from(JSON.stringify({ role: 'owner', warehouseId: 'fixture', ownerId: 'fixture', exp: 4102444800 })).toString('base64url')}.x`);
    await page.route('**/*', async (route) => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
      if (u.origin === ORIGIN) {
        const f = path.join(SITE, decodeURIComponent(p));
        return fs.existsSync(f) ? route.fulfill({ path: f }) : route.fulfill({ status: 404, body: '' });
      }
      if (u.hostname === 'cdnjs.cloudflare.com' && p === '/ajax/libs/xlsx/0.18.5/xlsx.full.min.js') {
        if (!xlsx) xlsx = route.fetch().then(async (r) => ({ status: r.status(), headers: r.headers(), body: await r.body() }));
        return route.fulfill(await xlsx);
      }
      if (u.origin !== 'https://api.argus-ai.online') return route.abort();
      const body = req.postDataJSON();
      let data = [];
      if (p === '/api/leads/manage/access') return route.fulfill({ status: 403, json: { error: 'fixture' } });
      if (p === '/api/warehouses/me') data = { name: 'Тестовый склад', timezone: 'Europe/Moscow', stock_source: 'argus', setup_at: '2001-01-01' };
      if (p === '/api/warehouses/me/readiness') data = { steps: [] };
      if (p === '/api/sellers/companies') data = [{ id: COMPANY, name: 'Тестовый клиент', keys: [] }];
      if (p === '/api/sellers/stock-summary') data = { sellers: [] };
      if (p === '/api/alerts/today') data = { ship: {}, receive: {}, decide: {}, exchange: { sync: [] } };
      if (p === '/api/alerts') data = { alerts: [] };
      if (p === '/api/inventory/advice' || p === '/api/inventory/settings') data = { reasons: [] };
      if (p === '/api/sync/status') data = {};
      if (p === '/api/cells/rows') data = [{ id: 'row', row_num: 1, rack_count: 1, tier_count: 1, blocks: [{ id: 'block', rack_start: 1, rack_end: 1, tier_start: 1, tier_end: 1, state: 'empty', stock: [] }] }];
      if (p === '/api/vwarehouses') data = { warehouses: [{ id: TARGET, name: 'Озон', marketplace: 'other', keepSeparate: false }], rights: { decide: true }, wbChoices: [] };
      if (p === '/api/vwarehouses/transfer-candidates') data = { companyId: COMPANY, toVw: TARGET, fromVw: null, items: catalog, nextCursor: null };
      if (p === '/api/vwarehouses/transfers/preview') {
        data = { companyId: COMPANY, toVw: TARGET, canCommit: true, errors: [],
          items: body.items.map((r, i) => ({ ...r, ...catalog.find((c) => c.sku === r.sku), qty: Number(r.qty), row: i + 1, expectedStatus: 'done' })) };
      }
      return route.fulfill({ json: data });
    });
    await page.goto(`${ORIGIN}/cabinet_main.html`);
    await page.locator('#view-home.active').waitFor();
    await page.waitForFunction(() => document.querySelector('#productFormCompany')?.options.length >= 1 && !!window.XLSX);
    await page.locator('#nav-products').click(); await page.locator('#tab-warehouse').click();
    if (!await page.locator('#warehouseVwWorkspace').evaluate((el) => el.open)) await page.locator('#warehouseVwWorkspace>summary').click();
    await page.evaluate((id) => setWarehouseVwCompany(id), COMPANY);
    await page.locator(`[data-vw-stock="${TARGET}"]`).click();
    await page.locator('#warehouseVwStockPane .vws-row').first().waitFor();
    const act = (name) => page.locator(`#warehouseVwStockPane [data-action="${name}"]`);
    await act('import').click();

    // Файл: заголовок и четыре товара; служебный размер листа (<dimension>) — ref.
    // Поправлено при починке 05.10: SheetJS при записи не пишет ячейки за
    // пределами !ref, и прежний файл на деле содержал 2 товара, а не 4. Теперь
    // все 4 строки в файле, а занижена только пометка — как у программ выгрузки.
    const upload = async (ref) => {
      const bytes = await page.evaluate((r) => {
        const ws = XLSX.utils.aoa_to_sheet([['Артикул', 'Количество'], ['A-1', 1], ['A-2', 1], ['A-3', 1], ['A-4', 1]]);
        const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, ws, 'Товары');
        const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(b, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
        const entry = zip.FileIndex[zip.FullPaths.findIndex((x) => /worksheets\/sheet1\.xml$/.test(x))];
        const xml = new TextDecoder().decode(entry.content).replace(/<dimension ref="[^"]+"\/>/, `<dimension ref="${r}"/>`);
        entry.content = new TextEncoder().encode(xml); entry.size = entry.content.length;
        return Array.from(new Uint8Array(XLSX.CFB.write(zip, { type: 'array', fileType: 'zip' })));
      }, ref);
      await page.locator('#warehouseVwStockPane input[type=file]').setInputFiles({ name: `rows-${ref}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) });
      await page.waitForTimeout(800);
    };
    const parse = async () => {
      for (const [name, col] of [['sku', 'A'], ['qty', 'B']]) {
        const option = act(`map-${name}`).filter({ hasText: new RegExp(`^${col} —`) });
        if (!(await option.isVisible())) await page.locator('.vws-import-mapping details').nth(name === 'sku' ? 2 : 4).locator('summary').click();
        await option.click();
      }
      await act('parse').click();
      await page.locator('.vws-import-summary').waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-action=apply-import]')?.disabled);
      return page.locator('.vws-import-table tbody tr').count();
    };

    // 1. Размер листа в файле занижен: «A1:B3» при четырёх товарах.
    await upload('A1:B3');
    await page.locator('.vws-import-mapping').waitFor();
    const rows = await parse();
    const summary = await page.locator('.vws-import-summary').innerText();
    v.expect('в файле 4 товара — проверяются 4 строки', rows === 4, '4 строки к проверке',
      `${rows} строки; экран пишет: «${summary.replace(/\s+/g, ' ')}»`);

    // 2. Размер листа завышен: Excel считает занятыми 20 000 строк, данных — 4.
    await upload('A1:B20000');
    const notice = (await page.locator('#warehouseVwStockPane [data-role=notice]').innerText().catch(() => '')).trim();
    const mapping = await page.locator('.vws-import-mapping').count();
    v.expect('файл с 4 товарами принимается', !/10 000/.test(notice) && mapping > 0,
      'выбор столбцов для 4 строк', `отказ: «${notice}»`);
    await page.close();
  } catch (err) { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; } finally { await browser.close(); v.done(); }
})();
