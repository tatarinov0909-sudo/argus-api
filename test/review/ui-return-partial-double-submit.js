// Две реальные вкладки формы возврата, реальный локальный API, без внешней сети.
const fs = require('node:fs'); const path = require('node:path');
process.env.ARGUS_PLAYWRIGHT_MODULE = 'C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright';
const { browser, SITE } = require('../attack-0310/_ui');
const { startApp, stand, verdicts, fail, realFetch } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp(); const v = verdicts('Две вкладки частичного возврата'); let b;
  try {
    const s = await stand(app); const [A, D] = s.cells;
    const ret = await app.ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: [{ sku: 'R-1', qty: 10 }] });
    const inv = await app.ok('GET', `/api/invoices/${ret.id}`, s.worker);
    b = await browser(); const ctx = await b.newContext({ viewport: { width: 375, height: 1000 } });
    await ctx.route('**/*', async (route) => {
      const req = route.request(), u = new URL(req.url());
      if (u.origin === 'http://argus.test') {
        const f = path.resolve(SITE, '.' + decodeURIComponent(u.pathname));
        if (!f.startsWith(SITE + path.sep) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
        const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(f)];
        return route.fulfill({ body: fs.readFileSync(f), contentType: type || 'application/octet-stream' });
      }
      if (u.origin !== 'https://api.argus-ai.online') return route.abort();
      const h = req.headers(); const r = await realFetch(app.base + u.pathname + u.search, { method: req.method(),
        headers: { ...(h.authorization ? { Authorization: h.authorization } : {}), ...(h['content-type'] ? { 'Content-Type': h['content-type'] } : {}) },
        body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() });
      return route.fulfill({ status: r.status, body: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'application/json' });
    });
    await ctx.addInitScript(([t]) => { localStorage.setItem('argus_token', t); localStorage.setItem('argus_role', 'worker'); }, [s.worker]);
    const tabs = [await ctx.newPage(), await ctx.newPage()];
    for (const p of tabs) {
      await p.goto('http://argus.test/loader.html');
      await p.waitForFunction(() => typeof openOrder === 'function');
      await p.evaluate((id) => openOrder(id), ret.id);
      await p.locator('.bucket-option[data-bucket="good"]').click();
      await p.locator('#qtyValue').fill('3');
      await p.locator('.cell-option').filter({ hasText: A.label }).first().click();
    }
    // Обе формы получены до первого сохранения; действия выполняются один за другим:
    // даже обычная устаревшая вторая вкладка не предупреждает о новом состоянии.
    const responses = [];
    for (const p of tabs) {
      const saved = p.waitForResponse((r) => r.url().endsWith('/api/returns') && r.request().method() === 'POST');
      await p.locator('#confirmBtn').click();
      responses.push((await saved).status());
    }
    const records = await s.q('SELECT qty::int FROM return_records WHERE invoice_item_id = $1 AND quality_bucket = $2', [inv.items[0].id, 'good']);
    const recorded = records.reduce((n, r) => n + r.qty, 0);
    const stock = (await app.ok('GET', '/api/sellers/stock', s.seller)).rows.find((r) => r.sku === 'R-1');
    await tabs[1].locator('.bucket-option[data-bucket="defective"]').waitFor({ state: 'visible' });
    await tabs[1].screenshot({ path: 'C:/Users/tatar/Desktop/argus-review/screenshots/return-double-submit-after-375.png', fullPage: true });
    v.expect('две заранее открытые вкладки не удваивают одни 3 годных', recorded === 3,
      '3 годных, повторное действие отклонено/подтверждено пользователем', JSON.stringify({ responses, recorded, sellerTotal: stock.total }));
    const rest = await app.api('POST', '/api/returns', s.worker, { invoiceItemId: inv.items[0].id, qty: 7, qualityBucket: 'defective', cellBlockId: D.id });
    v.expect('реальные 7 бракованных можно учесть после двух нажатий', rest.status === 201, '3+7=10', JSON.stringify({ status: rest.status, error: rest.body && rest.body.error }));
  } catch (e) { fail(e); } finally { v.done(); if (b) await b.close(); await app.stop(); }
})();
