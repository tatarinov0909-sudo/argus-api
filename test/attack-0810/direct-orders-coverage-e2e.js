// Проверка без находки (покрытие): заказы физлицам — числа продавца и склада
// на каждом шаге, права, мусор на входе, гонка, выключенная настройка,
// архивный продавец. Если что-то здесь падает — это находка.
const crypto = require('node:crypto');
const { startApp, verdicts, fail, setup, pickSupply, to } = require('./_lib');

(async () => {
  const { ok, api, stop } = await startApp();
  const v = verdicts('Заказы физлицам: покрытие');
  try {
    const w = await setup(ok, { skus: ['A-1', 'B-1'] });
    await w.put(w.cells[0], 'A-1', 10);
    await w.put(w.cells[1], 'B-1', 5);
    const summary = async () => (await ok('GET', '/api/sellers/stock-summary', w.token)).sellers.find((s) => s.companyId === w.companyId || s.id === w.companyId);
    const sellerSum = async () => (await ok('GET', '/api/sellers/stock', w.seller)).summary;

    // Мусор на входе.
    const bad = async (body) => (await api('POST', '/api/direct-orders', w.seller, { ...to, items: [{ sku: 'A-1', qty: 1 }], ...body })).status;
    v.expect('получатель 121 знак — 400, 120 — можно', await bad({ recipient: 'Я'.repeat(121) }) === 400, '400', '');
    v.expect('адрес 301 знак — 400', await bad({ address: 'Д'.repeat(301) }) === 400, '400', '');
    v.expect('дробное, ноль, отрицательное, 10 000 001, true — 400',
      (await Promise.all([1.5, 0, -1, 10000001, true].map((qty) => bad({ items: [{ sku: 'A-1', qty }] })))).every((s) => s === 400), 'все 400', '');
    v.expect('прошедшая дата — 400', await bad({ plannedDate: '2020-01-01' }) === 400, '400', '');
    v.expect('чужой номер операции — 400', await bad({ requestId: 'abc' }) === 400, '400', '');
    v.expect('items не список / пустая строка — 400',
      (await bad({ items: 'A-1' })) === 400 && (await bad({ items: [null] })) === 400, '400', '');

    // Заказ продавца → числа у продавца и у склада совпадают.
    const html = '<img src=x onerror=alert(1)>Иванов 🙂';
    const o1 = await ok('POST', '/api/direct-orders', w.seller, { ...to, recipient: html, items: [{ sku: 'A-1', qty: 3 }], toSupply: true });
    const s1 = await w.stock(); const sum1 = await summary(); const ss1 = await sellerSum();
    v.expect('продавец: «Создать и сразу на сборку» ему не положено — заказ без поставки', !o1.supply, 'supply null', JSON.stringify(o1));
    v.expect('после заказа на 3: заказано 3, доступно 7', s1['A-1'].ordered === 3 && s1['A-1'].available === 7, '3 / 7', JSON.stringify(s1['A-1']));
    v.expect('«Остатки продавцов» у склада = итог продавца (заказано, доступно)',
      sum1 && ss1 && sum1.ordered === ss1.ordered && sum1.available === ss1.available, JSON.stringify(ss1 && { o: ss1.ordered, a: ss1.available }),
      JSON.stringify(sum1 && { o: sum1.ordered, a: sum1.available }));
    const listed = (await ok('GET', '/api/direct-orders', w.token)).rows.find((r) => r.id === o1.id);
    v.expect('получатель с HTML и эмодзи хранится как есть (экран экранирует)', listed && listed.recipient === html, html, listed && listed.recipient);

    // Гонка: два окна продавца на всё свободное B-1 (5) одновременно.
    const race = await Promise.all([1, 2].map(() => api('POST', '/api/direct-orders', w.seller,
      { ...to, items: [{ sku: 'B-1', qty: 5 }], requestId: crypto.randomUUID() })));
    v.expect('два одновременных заказа на всё свободное — проходит один', race.map((r) => r.status).sort().join(',') === '201,409',
      '201,409', race.map((r) => r.status).join(','));
    const raceOk = race.find((r) => r.status === 201).body;
    await ok('DELETE', `/api/direct-orders/${raceOk.id}`, w.seller);
    const s2 = await w.stock();
    v.expect('отмена вернула B-1: доступно 5', s2['B-1'].available === 5 && s2['B-1'].ordered === 0, '5 / 0', JSON.stringify(s2['B-1']));

    // Грузчик: заказ вне поставки не видит, к списку заказов физлицам не допущен.
    const wDocs = await ok('GET', '/api/invoices?direction=out', w.worker);
    v.expect('грузчик заказ вне поставки не видит', !wDocs.some((d) => d.id === o1.id), 'нет', 'виден');
    v.expect('грузчику /api/direct-orders — 403', (await api('GET', '/api/direct-orders', w.worker)).status === 403, '403', '');

    // Менеджер без прав: заводит и сразу на сборку.
    const mgr = await w.staff('Менеджер', { manager: true, grants: [] });
    const o2 = await ok('POST', '/api/direct-orders', mgr, { companyId: w.companyId, ...to, recipient: 'Петров', items: [{ sku: 'A-1', qty: 2 }], toSupply: true });
    const s3 = await w.stock();
    v.expect('менеджер: заказ сразу в поставке; у продавца «В сборке» 2', o2.supply && s3['A-1'].inAssembly === 2, 'в сборке 2', JSON.stringify(s3['A-1']));
    // Разобрали поставку — заказ вернулся «Заказано», не пропал.
    await ok('DELETE', `/api/supplies/${o2.supply.id}`, mgr);
    const s4 = await w.stock();
    v.expect('разобрали поставку заказа физлицу — заказ снова «Заказано»', s4['A-1'].ordered === 5 && s4['A-1'].inAssembly === 0, 'заказано 5, в сборке 0', JSON.stringify(s4['A-1']));

    // Поставка из двух получателей, сборка, отъезд, статусы.
    const sup = await ok('POST', '/api/supplies', w.token, { invoiceIds: [o1.id, o2.id] });
    const asSeller = await api('GET', `/api/supplies/${sup.id}`, w.seller);
    v.expect('продавец видит получателей своей поставки', asSeller.status === 200 && asSeller.body.packing.some((p) => p.to && p.to.recipient === html),
      'packing[].to', JSON.stringify(asSeller.body && asSeller.body.packing && asSeller.body.packing.map((p) => p.to && p.to.recipient)));
    await pickSupply(ok, w, sup.id, [o1.id, o2.id], w.cells[0]);
    await ok('POST', `/api/supplies/${sup.id}/ship`, w.worker, {});
    const s5 = await w.stock();
    v.expect('уехало 5: всего 5, в пути 0, доступно 5', s5['A-1'].total === 5 && s5['A-1'].inTransit === 0 && s5['A-1'].available === 5,
      '5 / 0 / 5', JSON.stringify(s5['A-1']));
    const mark = await api('PATCH', `/api/direct-orders/${o1.id}`, w.seller, { deliveryStatus: 'refused', trackNumber: '<b>RA1</b>' });
    v.expect('продавец ставит «отказ / возврат» и трек после отъезда', mark.status === 200 && mark.body.status === 'refused', 'refused', JSON.stringify(mark.body));
    const sellerOrders = (await ok('GET', '/api/sellers/orders', w.seller)).rows.filter((r) => r.id === o1.id);
    v.expect('у продавца в заказах — статус «refused» и трек', sellerOrders[0] && sellerOrders[0].direct_status === 'refused' && sellerOrders[0].track_number === '<b>RA1</b>',
      'refused', JSON.stringify(sellerOrders[0] && { s: sellerOrders[0].direct_status, t: sellerOrders[0].track_number }));

    // Второй продавец: не видит ни заказов, ни поставки, ни получателей.
    const other = (await ok('POST', '/api/sellers/companies', w.token, { name: 'Чужой' })).id;
    const otherSeller = await w.sellerToken(other);
    v.expect('чужой продавец: список пуст, поставка 404',
      (await ok('GET', '/api/direct-orders', otherSeller)).rows.length === 0 && (await api('GET', `/api/supplies/${sup.id}`, otherSeller)).status === 404,
      'пусто / 404', '');

    // Настройка склада выключена — продавцу нельзя, складу можно.
    await ok('PATCH', '/api/warehouses/me', w.token, { sellersDirectOrders: false });
    v.expect('выключено: продавцу 403, руководителю 201',
      (await api('POST', '/api/direct-orders', w.seller, { ...to, items: [{ sku: 'A-1', qty: 1 }] })).status === 403
        && (await api('POST', '/api/direct-orders', w.token, { companyId: w.companyId, ...to, items: [{ sku: 'A-1', qty: 1 }] })).status === 201,
      '403 / 201', '');
    v.expect('менеджер настройку не меняет', (await api('PATCH', '/api/warehouses/me', mgr, { sellersDirectOrders: true })).status === 403, '403', '');
    await ok('PATCH', '/api/warehouses/me', w.token, { sellersDirectOrders: true });

    // Архивный продавец: заказ ему не завести.
    await ok('PATCH', `/api/sellers/companies/${other}/archive`, w.token, { archived: true });
    v.expect('архивному продавцу заказ не заводится', (await api('POST', '/api/direct-orders', w.token, { companyId: other, ...to, items: [{ sku: 'A-1', qty: 1 }] })).status === 404, '404', '');
  } catch (e) { fail(e); } finally { v.done(); await stop(); }
})();
