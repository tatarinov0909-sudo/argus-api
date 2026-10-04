// Реальная страница wt-product + реальный API отдельной синтетической БД.
// Все запросы внешнего API перехватываются и пересылаются лишь на localhost.
const fs = require('node:fs');
const path = require('node:path');
process.env.ARGUS_PLAYWRIGHT_MODULE = 'C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright';
const { browser, SITE } = require('../attack-0310/_ui');
const { startApp, stand, verdicts, fail, realFetch } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Экран годного возврата без ячейки');
  let b;
  try {
    const s = await stand(app);
    const got = await s.receive([{ vw: null, qty: 5, cell: s.cells[0] }]);
    if (got.results[0].status !== 201) throw Error('Фикстура приёмки не создана');
    const ret = await app.ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: [{ sku: 'R-1', qty: 3 }] });
    b = await browser();
    const p = await b.newPage({ viewport: { width: 375, height: 900 } });
    await p.route('**/*', async (route) => {
      const req = route.request(); const u = new URL(req.url());
      if (u.origin === 'http://argus.test') {
        const f = path.resolve(SITE, '.' + decodeURIComponent(u.pathname));
        if (!f.startsWith(SITE + path.sep) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
        const ext = path.extname(f);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
        return route.fulfill({ body: fs.readFileSync(f), contentType: types[ext] || 'application/octet-stream' });
      }
      if (u.origin !== 'https://api.argus-ai.online') return route.abort();
      const h = req.headers();
      const r = await realFetch(app.base + u.pathname + u.search, { method: req.method(),
        headers: { ...(h.authorization ? { Authorization: h.authorization } : {}), ...(h['content-type'] ? { 'Content-Type': h['content-type'] } : {}) },
        body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() });
      const headers = { 'content-type': r.headers.get('content-type') || 'application/json' };
      if (r.headers.get('x-argus-token')) headers['x-argus-token'] = r.headers.get('x-argus-token');
      return route.fulfill({ status: r.status, body: Buffer.from(await r.arrayBuffer()), headers });
    });
    await p.addInitScript(([t]) => { localStorage.setItem('argus_token', t); localStorage.setItem('argus_role', 'worker'); }, [s.worker]);
    await p.goto('http://argus.test/loader.html');
    await p.waitForFunction(() => typeof openOrder === 'function');
    await p.evaluate((id) => openOrder(id), ret.id);
    const good = p.locator('.bucket-option[data-bucket="good"]');
    await good.waitFor({ state: 'visible' });
    await good.click();
    const button = p.locator('#confirmBtn');
    await button.scrollIntoViewIfNeeded();
    const enabled = await button.isEnabled();
    const text = await button.innerText();
    const selected = await p.locator('.cell-option.selected').count();
    console.log('Экран: ' + JSON.stringify({ confirmEnabled: enabled, confirmText: text, selectedCellOptions: selected }));
    await p.screenshot({ path: 'C:/Users/tatar/Desktop/argus-review/screenshots/return-good-without-cell-before-375.png', fullPage: true });
    v.expect('без выбранной ячейки кнопка годного возврата не закрывает работу', !enabled, 'кнопка требует место', JSON.stringify({ enabled, text, selected }));
    if (enabled) {
      await button.click();
      await p.waitForFunction(() => document.body.innerText.includes('Разобрано') || document.body.innerText.includes('разобран') || document.body.innerText.includes('Готово'), null, { timeout: 5000 }).catch(() => {});
      const card = await app.ok('GET', `/api/invoices/${ret.id}`, s.worker);
      const stock = (await app.ok('GET', '/api/sellers/stock', s.seller)).rows.find((r) => r.sku === 'R-1');
      const records = await s.q('SELECT qty::int, cell_block_id FROM return_records WHERE invoice_item_id = $1', [card.items[0].id]);
      console.log('После реального нажатия: ' + JSON.stringify({ status: card.status, total: stock.total, available: stock.available, records }));
      await p.screenshot({ path: 'C:/Users/tatar/Desktop/argus-review/screenshots/return-good-without-cell-after-375.png', fullPage: true });
      v.expect('после реального нажатия товар учтён либо возврат не завершён', card.status !== 'completed' || stock.total === 8,
        '8 шт. либо незавершённый возврат', JSON.stringify({ status: card.status, total: stock.total, available: stock.available }));
    }
  } catch (e) { fail(e); } finally { v.done(); if (b) await b.close(); await app.stop(); }
})();
