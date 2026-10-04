// Независимая проверка 03.10: только одноразовая БД run-probe, наружная сеть закрыта.
const fs = require('fs');
const path = require('path');
const { startApp, stand, verdicts, fail, realFetch } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Изоляция и охрана API');
  const evidence = [];
  try {
    const { api, ok } = app;
    const a = await stand(app, { skus: [['ISO-SAME', 'Только компания A']], racks: 8 });
    const z = await stand(app, { skus: [['ISO-SAME', 'Только чужой tenant Z']], racks: 8 });
    const bCompany = (await ok('POST', '/api/sellers/companies', a.owner, { name: 'Только компания B' })).id;
    await ok('POST', '/api/products', a.owner, { companyId: bCompany, sku: 'ISO-SAME', name: 'Только компания B' });
    const bKey = await ok('POST', `/api/sellers/companies/${bCompany}/keys`, a.owner, {});
    const bSeller = (await ok('POST', '/api/auth/seller/login', null, { keyCode: bKey.key_code, name: 'Продавец B' })).token;
    const request = async (label, method, url, token, body, expected, check) => {
      const r = await api(method, url, token, body);
      v.expect(label, r.status === expected && (!check || check(r.body)), expected + (check ? ' + содержимое' : ''), JSON.stringify({ status: r.status, body: r.body }));
      evidence.push({ label, method, url, expected, actual: r.status, content: !check || check(r.body) });
      return r;
    };
    const binary = async (label, method, url, token, bytes, expected, type = 'application/pdf') => {
      const r = await realFetch(app.base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': type }, ...(bytes ? { body: bytes } : {}) });
      const data = Buffer.from(await r.arrayBuffer());
      v.expect(label, r.status === expected, expected, r.status);
      evidence.push({ label, method, url, expected, actual: r.status });
      return data;
    };
    const vwA = await ok('POST', '/api/vwarehouses', a.owner, { companyId: a.company, name: 'Склад A', marketplace: 'wb' });
    const vwB = await ok('POST', '/api/vwarehouses', a.owner, { companyId: bCompany, name: 'Склад B', marketplace: 'wb' });
    const vwZ = await ok('POST', '/api/vwarehouses', z.owner, { companyId: z.company, name: 'Склад Z', marketplace: 'wb' });
    await a.receive([{ qty: 20, cell: a.cells[0] }], { sku: 'ISO-SAME' });
    await z.receive([{ qty: 20, cell: z.cells[0] }], { sku: 'ISO-SAME' });
    const receiptA = (await ok('POST', '/api/sellers/inbound', a.seller, { apply: true, grid: [['Артикул', 'Количество'], ['ISO-SAME', 5]] })).invoice;
    const receiptB = (await ok('POST', '/api/sellers/inbound', bSeller, { apply: true, grid: [['Артикул', 'Количество'], ['ISO-SAME', 6]] })).invoice;
    const receiptZ = (await ok('POST', '/api/sellers/inbound', z.seller, { apply: true, grid: [['Артикул', 'Количество'], ['ISO-SAME', 7]] })).invoice;
    const fullA = await ok('GET', `/api/invoices/${receiptA.id}`, a.owner);
    const docA = await ok('POST', `/api/inbound/${receiptA.id}/documents`, a.seller, { kind: 'УПД', number: 'СЕКРЕТ-A-СИНТЕТИКА' });
    const docB = await ok('POST', `/api/inbound/${receiptB.id}/documents`, bSeller, { kind: 'УПД', number: 'СЕКРЕТ-B-СИНТЕТИКА' });
    const whDocA = await ok('POST', `/api/inbound/${receiptA.id}/documents`, a.owner, { kind: 'ТТН', number: 'ДОКУМЕНТ-СКЛАДА' });
    const pdf = Buffer.from('%PDF-1.4\nONLY-SYNTHETIC-A\n%%EOF');
    await binary('свой документ можно загрузить', 'PUT', `/api/inbound/${receiptA.id}/documents/${docA.id}/file`, a.seller, pdf, 200);
    await ok('POST', `/api/inbound/${receiptA.id}/comments`, a.seller, { body: 'Приватная синтетическая переписка A' });
    const photoMove = await ok('POST', '/api/defects/moves', a.worker, { companyId: a.company, sku: 'ISO-SAME', fromCellBlockId: a.cells[0].id, toCellBlockId: a.cells[1].id, qty: 3, bucket: 'defective', note: 'Синтетика' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tAAAAABJRU5ErkJggg==', 'base64');
    await binary('своё фото можно загрузить', 'PUT', `/api/defects/moves/${photoMove.id}/photo`, a.worker, png, 200, 'image/png');
    const decisionA = await ok('POST', '/api/sellers/defects/decisions', a.seller, { sku: 'ISO-SAME', bucket: 'defective', qty: 1, action: 'dispose' });
    const orderA = await ok('POST', '/api/invoices', a.owner, { companyId: a.company, direction: 'out', number: 'ИСО-ОТГРУЗКА-A', items: [{ sku: 'ISO-SAME', name: 'Только компания A', declaredQty: 2 }] });
    const supplyA = await ok('POST', '/api/supplies', a.owner, { invoiceIds: [orderA.id], marketplace: 'wb', destination: 'Синтетический пункт', virtualWarehouseId: null });
    const transferA = await ok('POST', '/api/vwarehouses/transfers', a.seller, { sku: 'ISO-SAME', qty: 1, fromVw: null, toVw: vwA.id });
    await ok('PATCH', '/api/vwarehouses/rights', a.seller, { rights: { decide: false } });
    const divergent = (await ok('POST', '/api/sellers/inbound', a.seller, { apply: true, grid: [['Артикул', 'Количество', 'Склад'], ['ISO-SAME', 5, vwA.name], ['ISO-SAME', 5, '']] })).invoice;
    const divItems = (await ok('GET', `/api/invoices/${divergent.id}`, a.owner)).items;
    await ok('POST', `/api/receiving/session/${divergent.id}/start`, a.worker, {});
    for (const item of divItems) await ok('POST', '/api/receiving', a.worker, { invoiceItemId: item.id, acceptedQty: item.virtual_warehouse_id ? 5 : 3, cellBlockId: a.cells[2].id });
    const quantityDecision = (await ok('GET', '/api/vwarehouses/decisions', a.seller)).find(d => d.kind === 'receiving');
    if (!quantityDecision) throw Error('Не создан контрольный спор по количеству');
    const notificationIds = (await ok('GET', '/api/vwarehouses/notifications', a.seller)).map(n => n.id);

    // Контрольные доступы доказывают, что чужие ID реально существуют и содержат данные.
    for (const [label, url] of [['приход', `/api/inbound/${receiptA.id}`], ['накладная', `/api/invoices/${receiptA.id}`], ['акт приёмки', `/api/acts/receipt/${receiptA.id}`], ['акт брака', `/api/acts/defect/${decisionA.id}`], ['поставка', `/api/supplies/${supplyA.id}`]]) {
      await request('контроль своего ID: ' + label, 'GET', url, a.seller, undefined, 200);
    }
    v.expect('свой документ — те же байты', (await binary('свой документ GET', 'GET', `/api/inbound/${receiptA.id}/documents/${docA.id}/file`, a.seller, null, 200)).equals(pdf), 'байты PDF', 'сравнение Buffer');
    v.expect('своё фото — те же байты', (await binary('своё фото GET', 'GET', `/api/defects/moves/${photoMove.id}/photo`, a.seller, null, 200)).equals(png), 'байты PNG', 'сравнение Buffer');
    const snapshot = async () => {
      const tables = ['invoices', 'invoice_items', 'invoice_documents', 'invoice_comments', 'defect_moves', 'defect_decisions', 'cell_stock', 'virtual_warehouses', 'vw_transfers', 'vw_decisions', 'seller_notifications', 'companies'];
      const data = {};
      for (const table of tables) data[table] = await a.q(`SELECT to_jsonb(t) AS x FROM ${table} t ORDER BY to_jsonb(t)::text`);
      return JSON.stringify(data);
    };
    const before = await snapshot();
    // ID продавца A пробует продавец B (тот же склад), затем все роли чужого tenant Z.
    for (const [who, token] of [['seller B', bSeller], ['seller Z', z.seller], ['owner Z', z.owner], ['manager Z', z.manager]]) {
      const tests = [
        ['GET', `/api/inbound/${receiptA.id}`], ['GET', `/api/invoices/${receiptA.id}`],
        ['GET', `/api/acts/receipt/${receiptA.id}`], ['GET', `/api/acts/defect/${decisionA.id}`], ['GET', `/api/supplies/${supplyA.id}`],
        ['PATCH', `/api/inbound/${receiptA.id}`, { boxes: 99 }], ['DELETE', `/api/inbound/${receiptA.id}`],
        ['POST', `/api/inbound/${receiptA.id}/comments`, { body: 'Чужая запись' }],
        ['POST', `/api/inbound/${receiptA.id}/documents`, { kind: 'УПД' }],
        ['DELETE', `/api/inbound/${receiptA.id}/documents/${docA.id}`],
        ['POST', `/api/vwarehouses/transfers/${transferA.id}/decide`, { approve: true }],
      ];
      for (const [method, url, body] of tests) await request(`${who}: ${method} ${url}`, method, url, token, body, 404);
      await binary(`${who}: чужой документ GET`, 'GET', `/api/inbound/${receiptA.id}/documents/${docA.id}/file`, token, null, 404);
      await binary(`${who}: чужой документ PUT`, 'PUT', `/api/inbound/${receiptA.id}/documents/${docA.id}/file`, token, pdf, 404);
      await binary(`${who}: чужое фото GET`, 'GET', `/api/defects/moves/${photoMove.id}/photo`, token, null, 404, 'image/png');
    }
    for (const [who, token] of [['seller B', bSeller], ['seller Z', z.seller]]) {
      await request(`${who}: чужой вердикт`, 'POST', `/api/inbound/${divergent.id}/verdict`, token, { verdict: 'agreed' }, 404);
      await request(`${who}: чужое решение количества`, 'POST', `/api/vwarehouses/decisions/${quantityDecision.id}`, token, { confirm: true }, 404);
      await request(`${who}: чужие уведомления seen`, 'POST', '/api/vwarehouses/notifications/seen', token, { ids: notificationIds }, 200, b => b.seen === 0);
    }
    for (const [who, token] of [['owner Z', z.owner], ['manager Z', z.manager], ['worker Z', z.worker]]) {
      await request(`${who}: чужой приход arrived`, 'POST', `/api/inbound/${receiptA.id}/arrived`, token, { boxes: 2 }, 404);
      await binary(`${who}: чужое фото PUT`, 'PUT', `/api/defects/moves/${photoMove.id}/photo`, token, png, 404, 'image/png');
    }
    for (const [method, url, body] of [
      ['GET', `/api/inbound/${receiptA.id}`], ['GET', `/api/invoices/${receiptA.id}`], ['GET', `/api/supplies/${supplyA.id}`],
      ['POST', `/api/defects/tasks/${decisionA.id}/done`, {}],
      ['POST', '/api/receiving', { invoiceItemId: fullA.items[0].id, acceptedQty: 5, cellBlockId: z.cells[0].id }],
      ['POST', `/api/receiving/session/${receiptA.id}/start`, {}],
    ]) await request('worker Z: чужая работа ' + url, method, url, z.worker, body, 404);
    for (const [method, url, body] of [
      ['GET', `/api/acts/shipment/${supplyA.id}`], ['DELETE', `/api/supplies/${supplyA.id}`],
      ['POST', '/api/vwarehouses', { companyId: a.company, name: 'Чужое', marketplace: 'wb' }],
      ['PATCH', `/api/vwarehouses/${vwA.id}`, { companyId: a.company, name: 'Чужое' }],
      ['DELETE', `/api/vwarehouses/${vwA.id}?companyId=${a.company}`],
      ['POST', '/api/vwarehouses/items', { itemIds: [fullA.items[0].id], vw: null }],
      ['POST', '/api/returns/manual', { companyId: a.company, items: [{ sku: 'ISO-SAME', qty: 1 }] }],
      ['POST', '/api/sellers/defects/decisions', { companyId: a.company, sku: 'ISO-SAME', qty: 1, bucket: 'defective', action: 'dispose' }],
    ]) await request('owner Z: чужой ID ' + url, method, url, z.owner, body, 404);
    await request('worker Z: чужая компания в перемещении брака', 'POST', '/api/defects/moves', z.worker, { companyId: a.company, sku: 'ISO-SAME', fromCellBlockId: a.cells[0].id, toCellBlockId: z.cells[0].id, qty: 1, bucket: 'defective' }, 404);
    // Parent ID принадлежит B, child ID принадлежит A — обе границы должны проверяться.
    for (const [method, tail, body] of [['GET', '/file'], ['PUT', '/file', pdf], ['DELETE', '']]) {
      const url = `/api/inbound/${receiptB.id}/documents/${docA.id}${tail}`;
      if (method === 'DELETE') await request('свой parent / чужой child: DELETE', method, url, bSeller, undefined, 404);
      else await binary('свой parent / чужой child: ' + method, method, url, bSeller, body, 404);
    }
    await request('свой продавец не удаляет документ склада', 'DELETE', `/api/inbound/${receiptA.id}/documents/${whDocA.id}`, a.seller, undefined, 403);
    await binary('свой продавец не заменяет файл склада', 'PUT', `/api/inbound/${receiptA.id}/documents/${whDocA.id}/file`, a.seller, pdf, 403);

    const companyPaths = ['/api/sellers/profile', '/api/sellers/catalog', '/api/sellers/stock', '/api/sellers/documents', '/api/sellers/orders', '/api/sellers/defects', '/api/sellers/movements', '/api/sellers/supplies', '/api/sellers/history?sku=ISO-SAME', '/api/vwarehouses'];
    for (const url of companyPaths) {
      const sep = url.includes('?') ? '&' : '?';
      const own = await api('GET', url, bSeller);
      await request('seller B: подмена companyId игнорируется ' + url, 'GET', url + sep + 'companyId=' + a.company, bSeller, undefined, 200, body => JSON.stringify(body) === JSON.stringify(own.body));
      await request('owner Z: чужая компания ' + url, 'GET', url + sep + 'companyId=' + a.company, z.owner, undefined, 404);
    }
    for (const [url, id] of [['/api/invoices', receiptA.id], ['/api/supplies', supplyA.id], ['/api/vwarehouses/decisions', quantityDecision.id], ['/api/vwarehouses/transfers', transferA.id], ['/api/vwarehouses/notifications', notificationIds[0]]]) {
      for (const [who, token] of [['seller B', bSeller], ['seller Z', z.seller]]) await request(`${who}: список не содержит A ${url}`, 'GET', url, token, undefined, 200, b => !id || !JSON.stringify(b).includes(id));
    }
    await request('seller B: products company A пусто', 'GET', `/api/products?companyId=${a.company}`, bSeller, undefined, 200, b => Array.isArray(b) && b.length === 0);
    await request('owner Z: products company A пусто', 'GET', `/api/products?companyId=${a.company}`, z.owner, undefined, 200, b => Array.isArray(b) && b.length === 0);
    await request('seller B: нельзя перенести товар на чужой VW', 'POST', '/api/vwarehouses/transfers', bSeller, { companyId: a.company, sku: 'ISO-SAME', qty: 1, fromVw: null, toVw: vwA.id }, 404);
    await request('owner A: чужой tenant VW при переносе', 'POST', '/api/vwarehouses/transfers', a.owner, { companyId: a.company, sku: 'ISO-SAME', qty: 1, fromVw: null, toVw: vwZ.id }, 404);
    await request('seller B: решение брака company A игнорируется', 'POST', '/api/sellers/defects/decisions', bSeller, { companyId: a.company, sku: 'ISO-SAME', qty: 1, bucket: 'defective', action: 'dispose' }, 409);
    await request('owner A: VW другой компании в ручном возврате', 'POST', '/api/returns/manual', a.owner, { companyId: a.company, items: [{ sku: 'ISO-SAME', qty: 1 }], vw: vwB.id }, 404);
    await request('owner A: ID VW не соответствует companyId', 'PATCH', `/api/vwarehouses/${vwB.id}`, a.owner, { companyId: a.company, name: 'Подмена' }, 404);
    await request('worker A: чужая ячейка назначения брака', 'POST', '/api/defects/moves', a.worker, { companyId: a.company, sku: 'ISO-SAME', fromCellBlockId: a.cells[0].id, toCellBlockId: z.cells[0].id, qty: 1, bucket: 'defective' }, 404);
    await request('worker A: чужая ячейка источника брака', 'POST', '/api/defects/moves', a.worker, { companyId: a.company, sku: 'ISO-SAME', fromCellBlockId: z.cells[0].id, toCellBlockId: a.cells[1].id, qty: 1, bucket: 'defective' }, 404);
    await binary('worker Z: чужое фото GET', 'GET', `/api/defects/moves/${photoMove.id}/photo`, z.worker, null, 404, 'image/png');
    v.expect('все чужие запросы не изменили данные склада A', (await snapshot()) === before, 'полное совпадение 12 таблиц до/после', 'сравнение снимков');

    // Owner-only / grants: корректная авторизация, роль без прав; проверяется ранний 403.
    const restricted = [
      ['GET', '/api/staff'], ['POST', '/api/staff', { name: 'Чужой ключ' }],
      ['POST', '/api/sellers/companies', { name: 'Запрещено' }], ['POST', `/api/sellers/companies/${a.company}/keys`, {}],
      ['GET', '/api/sellers/1c-counterparties'], ['PUT', `/api/sellers/companies/${a.company}/1c-counterparty`, {}],
      ['GET', '/api/sync/keys'], ['POST', '/api/sync/keys', {}], ['GET', '/api/sync/status'],
      ['POST', '/api/cells/rows', { configs: [{ rackCount: 1, tierCount: 1 }] }], ['PATCH', `/api/defects/zones/${a.cells[0].id}`, { on: true }],
      ['GET', '/api/cells/initial-stock/template'], ['POST', '/api/cells/initial-stock', {}], ['POST', '/api/cells/stock-align', {}],
      ['GET', '/api/inventory/settings'], ['PATCH', '/api/inventory/settings', {}], ['POST', '/api/inventory/runs', {}],
      ['PATCH', '/api/warehouses/me', {}], ['POST', '/api/auth/owner/password', {}], ['GET', '/api/alerts'],
      ['POST', '/api/agents/orchestrator/ask', {}],
    ];
    for (const [who, token] of [['seller', a.seller], ['worker', a.worker], ['manager grants=[]', a.manager]]) {
      for (const [method, url, body] of restricted) await request(`${who}: закрыто ${method} ${url}`, method, url, token, body, 403);
    }
    for (const [method, url, body] of [
      ['GET', '/api/cells/rows'], ['GET', `/api/cells/blocks/${a.cells[0].id}/contents`], ['GET', '/api/dropzones'], ['GET', '/api/inventory/tasks'],
      ['GET', '/api/agents/kladovshchik/find?q=ISO'],
    ]) await request('manager без warehouse: ' + url, method, url, a.manager, body, 403);
    for (const [method, url, body] of [
      ['GET', `/api/acts/receipt/${receiptA.id}`], ['GET', `/api/acts/defect/${decisionA.id}`], ['GET', `/api/acts/shipment/${supplyA.id}`],
      ['POST', `/api/inbound/${receiptA.id}/comments`, { body: 'нельзя' }], ['POST', `/api/inbound/${receiptA.id}/documents`, { kind: 'УПД' }],
      ['PATCH', `/api/inbound/${receiptA.id}`, { boxes: 1 }], ['DELETE', `/api/inbound/${receiptA.id}`],
      ['POST', '/api/sellers/defects/decisions', { companyId: a.company, sku: 'ISO-SAME', qty: 1, bucket: 'defective', action: 'dispose' }],
    ]) await request('worker: закрыто ' + url, method, url, a.worker, body, 403);
    await request('worker карточка скрывает документы и чат', 'GET', `/api/inbound/${receiptA.id}`, a.worker, undefined, 200, b => b.documents.length === 0 && b.comments.length === 0 && b.notes.length === 0);
    for (const [who, token] of [['owner', a.owner], ['manager', a.manager], ['worker', a.worker]]) {
      await request(`${who}: права склада изменяет только продавец`, 'PATCH', '/api/vwarehouses/rights', token, { rights: { decide: true } }, 403);
      await request(`${who}: количество подтверждает только продавец`, 'POST', `/api/vwarehouses/decisions/${quantityDecision.id}`, token, { confirm: true }, 403);
      await request(`${who}: акт согласует только продавец`, 'POST', `/api/inbound/${divergent.id}/verdict`, token, { verdict: 'agreed' }, 403);
    }
    for (const [who, token] of [['owner', a.owner], ['manager', a.manager], ['seller', a.seller]]) await request(`${who}: выполнение брака только работнику`, 'POST', `/api/defects/tasks/${decisionA.id}/done`, token, {}, 403);
    // Полный фактический список Express Router: базовые модули + leads/manage.
    const modules = ['auth', 'warehouses', 'staff', 'sellers', 'supplies', 'cells', 'dropzones', 'products', 'invoices', 'receiving', 'shipping', 'kits', 'marketplaces', 'leads', 'inventory', 'returns', 'journal', 'sync', 'agents', 'alerts', 'acts', 'inbound', 'defects', 'vwarehouses'];
    const inventory = [];
    const dummy = '00000000-0000-4000-8000-000000000001';
    const inspect = async (module, file, prefix) => {
      const router = require('../../src/' + file);
      const globalGuards = router.stack.filter(x => !x.route && x.name !== 'router').map(x => x.name);
      for (const layer of router.stack.filter(x => x.route)) for (const method of Object.keys(layer.route.methods)) {
        const route = layer.route;
        const actual = prefix + route.path.replace(/:[A-Za-z][A-Za-z0-9_]*(?:\([^)]*\))?/g, dummy);
        const intentionalPublic = module === 'auth' && route.path !== '/owner/password' || module === 'sync' && route.path === '/auth' || module === 'leads' && route.path === '/';
        const item = { method: method.toUpperCase(), path: prefix + route.path, guards: [...globalGuards, ...route.stack.map(x => x.name)], intentionalPublic };
        inventory.push(item);
        if (!intentionalPublic) {
          const r = await request('без токена ' + item.method + ' ' + item.path, item.method, actual, null, ['get', 'head'].includes(method) ? undefined : {}, 401);
          item.anonymousStatus = r.status;
        }
      }
    };
    for (const m of modules) await inspect(m, m + '/routes', '/api/' + m);
    await inspect('leads-manage', 'leads/manage', '/api/leads/manage');
    await request('искажённый токен на новом API', 'GET', `/api/inbound/${receiptA.id}`, 'not-a-valid-jwt', undefined, 401);
    await request('health намеренно публичный', 'GET', '/health', null, undefined, 200);
    fs.writeFileSync('C:/Users/tatar/Desktop/argus-review/security-route-inventory.json', JSON.stringify(inventory, null, 2));
    fs.writeFileSync('C:/Users/tatar/Desktop/argus-review/security-isolation-evidence.json', JSON.stringify(evidence, null, 2));
    console.log('МАРШРУТЫ ' + JSON.stringify({ total: inventory.length, protected: inventory.filter(x => !x.intentionalPublic).length, intentionalPublic: inventory.filter(x => x.intentionalPublic).map(x => x.method + ' ' + x.path) }));
    console.log('API evidence: ' + evidence.length + ' запросов с точным статусом. Продукт/реальные данные/сеть не изменялись.');
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
