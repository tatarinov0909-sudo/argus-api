// Аудит неизменённых страниц wt-product, реальные ответы своего localhost API.
const fs = require('fs'); const path = require('path');
process.env.ARGUS_PLAYWRIGHT_MODULE = 'C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright';
const { browser, SITE } = require('../attack-0310/_ui');
const { startApp, stand, verdicts, fail, realFetch } = require('../attack-0310/_lib');
const OUT = 'C:/Users/tatar/Desktop/argus-review';
(async () => {
  const app = await startApp(); const v = verdicts('Экраны грузчика и приходы руководителя');
  let chrome; const observations = []; const pageErrors = []; let sequence = 0;
  try {
    const names = Array.from({ length: 12 }, (_, i) => [`UI-${String(i + 1).padStart(2, '0')}`, (`Товар ${i + 1} — Очень длинное русское название товара для проверки переноса текста, упаковка подарочная большая и хрупкая. `.repeat(3)).slice(0, 245)]);
    const s = await stand(app, { skus: names, racks: 8 });
    const empty = await stand(app, { skus: [] });
    const stock = await s.receive(names.map(([sku, name], k) => ({ sku, name, qty: k === 0 ? 100000 : 30, cell: s.cells[k < 8 ? k : 0] })));
    if (stock.results.some(r => r.status !== 201)) throw Error('Не создан исходный товар');
    const receipt = (await app.ok('POST', '/api/sellers/inbound', s.seller, { apply: true, grid: [['Артикул', 'Количество'], ...names.map(([sku], i) => [sku, i === 0 ? 100000 : 10])], boxes: 100000, comment: 'Длинное описание привоза. '.repeat(12) })).invoice;
    await app.ok('POST', `/api/inbound/${receipt.id}/documents`, s.seller, { kind: 'УПД', number: 'ПРОВЕРКА-100000', supplier: 'Поставщик с очень длинным названием '.repeat(5) });
    await app.ok('POST', `/api/inbound/${receipt.id}/comments`, s.seller, { body: 'Подробное сообщение продавца по привозу товара. '.repeat(18), sku: names[0][0] });
    const ret = await app.ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: names.map(([sku], i) => ({ sku, qty: i === 0 ? 100000 : 10 })) });
    await app.ok('POST', '/api/defects/moves', s.worker, { companyId: s.company, sku: names[0][0], fromCellBlockId: s.cells[0].id, toCellBlockId: s.cells[6].id, qty: 3, bucket: 'defective', note: 'Проверка большого длинного текста '.repeat(8) });
    const dispose = await app.ok('POST', '/api/sellers/defects/decisions', s.seller, { sku: names[0][0], bucket: 'defective', qty: 2, action: 'dispose' });
    await app.ok('POST', '/api/sellers/defects/decisions', s.seller, { sku: names[0][0], bucket: 'defective', qty: 1, action: 'repack' });
    const vw = await app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Отдельный склад для проверки длинного названия', marketplace: 'wb', keepSeparate: true });
    await app.ok('POST', '/api/vwarehouses/transfers', s.owner, { companyId: s.company, sku: names[0][0], qty: 2, fromVw: null, toVw: vw.id });
    const order = await app.ok('POST', '/api/invoices', s.owner, { companyId: s.company, number: 'ПРОВЕРКА-ДЛИННОЙ-ПОСТАВКИ', direction: 'out', items: names.map(([sku, name], i) => ({ sku, name, declaredQty: i === 0 ? 90000 : 10 })) });
    const supply = await app.ok('POST', '/api/supplies', s.owner, { invoiceIds: [order.id], marketplace: 'wb', destination: 'Синтетический пункт назначения с очень длинным адресом, корпус и строение, комментарий для водителя', virtualWarehouseId: null });
    await app.ok('POST', '/api/inventory/runs', s.owner, {});
    const invTask = (await app.ok('GET', '/api/inventory/tasks', s.worker)).find(t => t.cellBlockId === s.cells[0].id);
    chrome = await browser();
    async function newPage(role, token, width, file = 'loader.html') {
      const p = await chrome.newPage({ viewport: { width, height: 900 } });
      p.on('pageerror', e => pageErrors.push({ role, width, message: e.message }));
      await p.route('**/*', async route => {
        const req = route.request(); const u = new URL(req.url());
        if (u.origin === 'http://argus.test') {
          const f = path.resolve(SITE, '.' + decodeURIComponent(u.pathname));
          if (!f.startsWith(SITE + path.sep) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
          const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
          return route.fulfill({ body: fs.readFileSync(f), contentType: types[path.extname(f)] || 'application/octet-stream' });
        }
        if (u.origin !== 'https://api.argus-ai.online') return route.abort();
        const h = req.headers();
        const r = await realFetch(app.base + u.pathname + u.search, { method: req.method(), headers: { ...(h.authorization ? { Authorization: h.authorization } : {}), ...(h['content-type'] ? { 'Content-Type': h['content-type'] } : {}) }, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() });
        const headers = { 'content-type': r.headers.get('content-type') || 'application/json' };
        if (r.headers.get('x-argus-token')) headers['x-argus-token'] = r.headers.get('x-argus-token');
        return route.fulfill({ status: r.status, body: Buffer.from(await r.arrayBuffer()), headers });
      });
      await p.addInitScript(([t, r]) => { localStorage.setItem('argus_token', t); localStorage.setItem('argus_role', r); }, [token, role]);
      await p.goto('http://argus.test/' + file); await p.waitForLoadState('networkidle');
      await p.evaluate(() => document.fonts.ready);
      return p;
    }
    async function capture(p, label, { print = false, last = null, bottom = false } = {}) {
      await p.waitForLoadState('networkidle'); await p.waitForTimeout(100);
      if (bottom) await p.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        for (const e of document.querySelectorAll('*')) if (e.scrollHeight > e.clientHeight + 20 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight;
      });
      const data = await p.evaluate(({ last }) => {
        const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        const rect = e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
        const fixed = [...document.querySelectorAll('*')].filter(e => vis(e) && getComputedStyle(e).position === 'fixed').map(e => ({ id: e.id, cls: e.className, ...rect(e) }));
        const visibleSelects = [...document.querySelectorAll('select')].filter(vis).map(e => ({ id: e.id, cls: e.className, ...rect(e) }));
        const overflow = [...document.querySelectorAll('body *')].filter(e => vis(e) && (e.getBoundingClientRect().right > innerWidth + 1 || e.getBoundingClientRect().left < -1)).slice(0, 18).map(e => ({ tag: e.tagName, id: e.id, cls: typeof e.className === 'string' ? e.className : '', ...rect(e) }));
        const lastNode = last ? [...document.querySelectorAll(last)].filter(vis).at(-1) : null;
        const lastRect = lastNode ? rect(lastNode) : null;
        const hit = lastNode ? document.elementFromPoint(Math.min(innerWidth - 3, Math.max(3, lastNode.getBoundingClientRect().left + 15)), Math.min(innerHeight - 3, Math.max(3, lastNode.getBoundingClientRect().bottom - 8))) : null;
        const numeric = [...document.querySelectorAll('b,td,input,.qty-value,.stock-row-qty')].filter(e => vis(e) && /\d/.test(e.value || e.textContent || '')).slice(0, 12).map(e => ({ text: (e.value || e.textContent).slice(0, 25), family: getComputedStyle(e).fontFamily, nums: getComputedStyle(e).fontVariantNumeric }));
        return { width: innerWidth, rootWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, bodyFont: getComputedStyle(document.body).fontFamily, bodyNums: getComputedStyle(document.body).fontVariantNumeric, golosLoaded: document.fonts.check('16px "Golos Text"'), overflow, visibleSelects, fixed, numeric, last: lastRect, lastHit: hit ? { tag: hit.tagName, id: hit.id, cls: hit.className, inLast: !!lastNode && (lastNode.contains(hit) || hit.contains(lastNode)) } : null, textEnd: document.body.innerText.slice(-350) };
      }, { last });
      const filename = 'ui-worker-' + (++sequence).toString().padStart(2, '0') + '-' + label + '-' + data.width + '.png';
      await p.screenshot({ path: OUT + '/screenshots/' + filename, fullPage: false });
      observations.push({ label, print, screenshot: filename, ...data });
      console.log('ЭКРАН ' + JSON.stringify({ label, width: data.width, root: data.rootWidth, body: data.bodyWidth, selects: data.visibleSelects.length, overflow: data.overflow.length, screenshot: filename }));
      if (!print) v.expect(label + ' ' + data.width + ': нет горизонтального скролла корня', data.rootWidth <= data.width + 1, data.width, data.rootWidth);
    }
    for (const width of [375, 1440]) {
      const p = await newPage('worker', s.worker, width);
      await capture(p, 'home', { bottom: true, last: '.home-tile' });
      await p.evaluate(() => openDocs('in')); await capture(p, 'receipt-list', { bottom: true, last: '.rcv-row,.receipt-row' });
      await p.evaluate(id => openReceipt(id), receipt.id); await capture(p, 'receipt-card', { bottom: true, last: '.rcv-item' });
      await p.evaluate(id => recvContinue(id), receipt.id); await p.locator('#productsList .product-row').first().click();   // приёмка сама открывает «Все товары прихода» — выбираем коробку, как грузчик
      await capture(p, 'receiving-100000', { bottom: true, last: '#confirmBtn' });
      await p.locator('#pauseBtn').click(); await capture(p, 'pause-sheet'); await p.evaluate(() => closeSheet());
      await p.evaluate(() => openDefect()); await capture(p, 'receiving-defect-sheet', { bottom: true, last: '#defGo' }); await p.evaluate(() => closeSheet());
      await p.evaluate(() => showHome()); await p.evaluate(() => openSupplies()); await capture(p, 'supplies');
      await p.evaluate(id => openSupply(id), supply.id); await capture(p, 'supply-products', { bottom: true, last: '.sp-row' });
      await p.evaluate(id => openSupplyPickList(id), supply.id); await capture(p, 'pick-list', { bottom: true, last: '.pick-line' });
      await p.evaluate(() => openMove()); await capture(p, 'move-cells', { bottom: true, last: '.stock-row' });
      await p.evaluate(([id, label]) => pickMoveCell(id, label), [s.cells[0].id, s.cells[0].label]); await p.evaluate(() => pickMoveStock(0)); await capture(p, 'move-action', { bottom: true });
      await p.evaluate(() => openDefectFromMove()); await capture(p, 'move-defect-sheet', { bottom: true, last: '#defGo' }); await p.evaluate(() => closeSheet());
      await p.evaluate(() => openDefectTasks()); await capture(p, 'defect-tasks', { bottom: true, last: '.def-task-go' });
      await p.evaluate(() => openVwMoves()); await capture(p, 'vw-move-tasks', { bottom: true, last: '.def-task-go' });
      await p.evaluate(() => openInventory()); await capture(p, 'inventory-list', { bottom: true, last: '.stock-row' });
      await p.evaluate(id => openInvTask(id), invTask.id); await capture(p, 'inventory-count', { bottom: true });
      await p.evaluate(() => openDocs('return')); await capture(p, 'returns-list');
      await p.evaluate(id => openOrder(id), ret.id); await p.locator('.bucket-option[data-bucket="good"]').click(); await capture(p, 'return-100000', { bottom: true, last: '#confirmBtn' });
      await p.evaluate(() => openManualReturn()); await p.locator('#mretQuery').fill('UI-01'); await p.locator('#mretFound .inv-search-result').first().waitFor(); await capture(p, 'new-return-search');
      await p.locator('#mretFound .inv-search-result').first().click(); await capture(p, 'new-return-form', { bottom: true, last: '.mret-go' });
      await p.close();
      const ep = await newPage('worker', empty.worker, width);
      for (const [label, action] of [['empty-home', 'showHome()'], ['empty-receipts', "openDocs('in')"], ['empty-supplies', 'openSupplies()'], ['empty-move', 'openMove()'], ['empty-defects', 'openDefectTasks()'], ['empty-vwmoves', 'openVwMoves()'], ['empty-inventory', 'openInventory()'], ['empty-returns', "openDocs('return')"]]) { await ep.evaluate(action); await capture(ep, label); }
      await ep.close();
      const owner = await newPage('owner', s.owner, width, 'cabinet_main.html');
      await owner.evaluate(() => switchView('receipts')); await capture(owner, 'owner-receipts', { bottom: true, last: '.rc-row' });
      await owner.evaluate(id => openReceipt(id), receipt.id); await capture(owner, 'owner-receipt-modal', { bottom: true, last: '.rc-bottom' });
      await owner.evaluate(() => closeReceipt()); await owner.evaluate(() => switchView('acts')); await capture(owner, 'owner-acts', { bottom: true, last: '.act-row' });
      await owner.close();
      for (const [label, file, token, role] of [['pick-print', 'pick_print.html?supplyId=' + supply.id, s.worker, 'worker'], ['receipt-print', 'act_print.html?kind=receipt&id=' + receipt.id, s.owner, 'owner'], ['defect-print', 'act_print.html?kind=defect&id=' + dispose.id, s.owner, 'owner']]) {
        const pp = await newPage(role, token, width, file); await capture(pp, label, { print: true }); await pp.emulateMedia({ media: 'print' }); await capture(pp, label + '-print-media', { print: true, bottom: true }); await pp.close();
      }
    }
    console.log('PAGEERRORS ' + JSON.stringify(pageErrors));
    fs.writeFileSync(OUT + '/ui-worker-receipts-observations.json', JSON.stringify({ observations, pageErrors }, null, 2));
  } catch (e) { fail(e); } finally { fs.writeFileSync(OUT + '/ui-worker-receipts-observations.json', JSON.stringify({ observations, pageErrors }, null, 2)); v.done(); if (chrome) await chrome.close(); await app.stop(); }
})();
