// Реальная страница/API: длинный option растягивает форму ответа внутри модального окна.
const fs = require('fs'); const path = require('path');
process.env.ARGUS_PLAYWRIGHT_MODULE = 'C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright';
const { browser, SITE } = require('../attack-0310/_ui');
const { startApp, stand, verdicts, fail, realFetch } = require('../attack-0310/_lib');
(async () => {
  const quantityOnly = process.env.ARGUS_REVIEW_RETURN_QUANTITY_ONLY === '1';
  const app = await startApp(); const v = verdicts(quantityOnly ? 'R25: число возврата видно целиком' : 'Форма ответа по длинному товару'); let b;
  const tag = Date.now(); const evidence = [];
  try {
    const title = ('Очень длинное русское название товара с размерами, материалами, комплектацией и особенностями упаковки. '.repeat(3)).slice(0, 245);
    const s = await stand(app, { skus: [['LONG-1', title]] });
    const receipt = (await app.ok('POST', '/api/sellers/inbound', s.seller, { apply: true, grid: [['Артикул', 'Количество'], ['LONG-1', 100000]] })).invoice;
    const ret = await app.ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: [{ sku: 'LONG-1', qty: 100000 }] });
    b = await browser();
    async function page(role, token, width, file) {
      const p = await b.newPage({ viewport: { width, height: 900 } });
      await p.route('**/*', async route => {
        const req = route.request(); const u = new URL(req.url());
        if (u.origin === 'http://argus.test') {
          const f = path.resolve(SITE, '.' + decodeURIComponent(u.pathname));
          if (!f.startsWith(SITE + path.sep) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
          const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
          return route.fulfill({ body: fs.readFileSync(f), contentType: types[path.extname(f)] || 'application/octet-stream' });
        }
        if (u.origin !== 'https://api.argus-ai.online') return route.abort();
        const h = req.headers(); const r = await realFetch(app.base + u.pathname + u.search, { method: req.method(), headers: { ...(h.authorization ? { Authorization: h.authorization } : {}), ...(h['content-type'] ? { 'Content-Type': h['content-type'] } : {}) }, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() });
        return route.fulfill({ status: r.status, body: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'application/json' });
      });
      await p.addInitScript(([t, r]) => { localStorage.setItem('argus_token', t); localStorage.setItem('argus_role', r); }, [token, role]);
      await p.goto('http://argus.test/' + file); await p.waitForLoadState('networkidle'); await p.evaluate(() => document.fonts.ready); return p;
    }
    for (const width of [375, 1440]) {
      if (!quantityOnly) {
      const p = await page('owner', s.owner, width, 'cabinet_main.html');
      await p.evaluate(() => switchView('receipts')); await p.evaluate(id => openReceipt(id), receipt.id);
      await p.locator('#rcBody').fill('Проверочное сообщение владельца: ' + 'Все слова должны быть видны в пределах поля. '.repeat(6));
      await p.evaluate(() => { const e = document.getElementById('receiptBody'); e.scrollTop = e.scrollHeight; });
      const d = await p.evaluate(() => {
        const bounds = e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, client: e.clientWidth, scroll: e.scrollWidth }; };
        return { viewport: innerWidth, root: document.documentElement.scrollWidth, modal: bounds(document.getElementById('receiptBody')), reply: bounds(document.querySelector('.rc-reply')), select: bounds(document.getElementById('rcAbout')), textarea: bounds(document.getElementById('rcBody')) };
      });
      const screenshot = `C:/Users/tatar/Desktop/argus-review/screenshots/receipt-reply-overflow-${tag}-${width}.png`;
      await p.screenshot({ path: screenshot }); evidence.push({ kind: 'reply', screenshot, ...d });
      console.log('ФОРМА ' + JSON.stringify({ ...d, screenshot }));
      v.expect(`корень ${width} не переполнен`, d.root <= width, width, d.root);
      v.expect(`поле ответа ${width} помещается внутри окна`, d.textarea.right <= d.modal.right && d.textarea.width <= d.reply.width + 1, 'textarea внутри modal/reply', JSON.stringify(d));
      v.expect(`выбор товара ${width} помещается внутри окна`, d.select.right <= d.modal.right, 'select внутри modal', JSON.stringify(d.select));
      await p.close();
      }
      const w = await page('worker', s.worker, width, 'loader.html');
      if (!quantityOnly) { await w.evaluate(id => recvContinue(id), receipt.id); await w.waitForLoadState('networkidle'); }
      for (const kind of (quantityOnly ? ['return'] : ['receiving', 'return'])) {
        if (kind === 'return') { await w.evaluate(id => openOrder(id), ret.id); await w.locator('.bucket-option[data-bucket="good"]').click(); await w.waitForLoadState('networkidle'); }
        const q = await w.locator('#qtyValue').inputValue();
        v.expect(`${kind} ${width}: реально показано значение100000`, q === '100000', '100000', q);
        await w.locator('#qtyValue').scrollIntoViewIfNeeded();
        const numbers = await w.locator('#qtyValue').evaluate(e => ({ value: e.value, width: e.clientWidth, scroll: e.scrollWidth, font: getComputedStyle(e).fontFamily, size: getComputedStyle(e).fontSize, nums: getComputedStyle(e).fontVariantNumeric, left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right }));
        v.expect(`${kind} ${width}: число 100000 видно целиком`, numbers.scroll <= numbers.width + 1, 'scrollWidth <= clientWidth', `${numbers.scroll} > ${numbers.width}`);
        const shot = `C:/Users/tatar/Desktop/argus-review/screenshots/worker-100000-${kind}-${tag}-${width}.png`;
        await w.screenshot({ path: shot }); evidence.push({ kind, width, numbers, screenshot: shot }); console.log('ЧИСЛО ' + JSON.stringify({ kind, width, ...numbers, screenshot: shot }));
        if (kind === 'receiving') {
          await w.locator('#pauseBtn').click(); await w.locator('.sheet-option[onclick="pauseTask(\'Перерыв\')"]').click(); await w.waitForLoadState('networkidle');
          const paused = `C:/Users/tatar/Desktop/argus-review/screenshots/worker-paused-${tag}-${width}.png`;
          await w.screenshot({ path: paused }); evidence.push({ kind: 'paused', width, screenshot: paused });
          await w.locator('#pauseResumeBtn').click(); await w.waitForLoadState('networkidle');
        }
      }
      await w.close();
    }
    fs.writeFileSync(`C:/Users/tatar/Desktop/argus-review/ui-receipt-reply-overflow-${tag}.json`, JSON.stringify(evidence, null, 2));
  } catch (e) { fail(e); } finally { v.done(); if (b) await b.close(); await app.stop(); }
})();
