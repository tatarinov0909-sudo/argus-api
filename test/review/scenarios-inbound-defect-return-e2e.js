// Независимая рецензия 03.10: единый синтетический путь сценариев 2, 3, 9.
// Только run-probe.cjs: отдельная БД; реальная сеть заблокирована _lib и preload.
const { startApp, stand, verdicts, fail, realFetch } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Приход, частичный брак, ручной возврат');
  try {
    const s = await stand(app, { skus: [['R-1', 'Товар для брака'], ['R-2', 'Второй товар'], ['R-3', 'Ручной ввод']] });
    const { ok, api } = app;
    const [A, B, C, D, E, F] = s.cells;
    const vw = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Проверочный WB', marketplace: 'wb' });
    await ok('PATCH', `/api/defects/zones/${D.id}`, s.owner, { on: true });
    const qty = (rows, sku) => rows.find((r) => r.sku === sku);
    const stock = async (label, expected) => {
      const seller = await ok('GET', '/api/sellers/stock', s.seller);
      const owner = await ok('GET', `/api/sellers/stock?companyId=${s.company}&view=seller`, s.owner);
      const rawOwner = await ok('GET', `/api/sellers/stock?companyId=${s.company}`, s.owner);
      const fields = ['total', 'ordered', 'inAssembly', 'inTransit', 'available', 'defective'];
      const clean = (row) => Object.fromEntries(fields.map((k) => [k, row && row[k]]));
      for (const [sku, total, defect] of expected) {
        const a = qty(seller.rows, sku); const b = qty(owner.rows, sku);
        v.expect(`${label}: ${sku}, продавец и владелец видят одни числа`, JSON.stringify(clean(a)) === JSON.stringify(clean(b)), JSON.stringify(clean(a)), JSON.stringify(clean(b)));
        v.expect(`${label}: ${sku}, годное отдельно от брака`, a && a.total === total && a.available === total && a.defective === defect,
          `всего/доступно=${total}, брак=${defect}`, JSON.stringify(clean(a)));
        const raw = qty(Array.isArray(rawOwner) ? rawOwner : rawOwner.rows, sku);
        v.expect(`${label}: ${sku}, основной остаток владельца совпадает`, raw && Number(raw.onHand) === total, total, JSON.stringify({ onHand: raw && raw.onHand }));
      }
      console.log('СНИМОК ' + label + ' ' + JSON.stringify({ summary: seller.summary, rows: seller.rows.map((r) => ({ sku: r.sku, ...clean(r) })) }));
      return seller;
    };
    // Таблица как результат чтения файла; загрузка/парсинг XLSX в браузере здесь не проверяется.
    const grid = [['Артикул', 'Количество', 'Склад'], ['R-1', 20, vw.name], ['R-2', 8, vw.name]];
    const preview = await ok('POST', '/api/sellers/inbound', s.seller, { grid });
    v.expect('предпросмотр таблицы: 2 товара, 28 единиц', preview.summary.products === 2 && preview.summary.units === 28, '2 / 28', JSON.stringify(preview.summary));
    const receipt = (await ok('POST', '/api/sellers/inbound', s.seller, { grid, apply: true, boxes: 2, comment: 'Независимая проверка прихода' })).invoice;
    const inv = await ok('GET', `/api/invoices/${receipt.id}`, s.owner);
    v.expect('руководитель видит приход продавца', inv.items.length === 2 && inv.company_id === s.company, 'две позиции своего продавца', JSON.stringify({ items: inv.items.length, company: inv.company_id === s.company }));
    const doc = await ok('POST', `/api/inbound/${receipt.id}/documents`, s.seller, { kind: 'УПД', number: 'ТЕСТ-001', date: '2026-10-03', supplier: 'Синтетический поставщик' });
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF');
    const put = await realFetch(app.base + `/api/inbound/${receipt.id}/documents/${doc.id}/file`, {
      method: 'PUT', headers: { Authorization: `Bearer ${s.seller}`, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('Документ проверки.pdf') }, body: pdf });
    v.expect('документ поставщика принят', put.status === 200, 200, put.status);
    const download = await realFetch(app.base + `/api/inbound/${receipt.id}/documents/${doc.id}/file`, { headers: { Authorization: `Bearer ${s.owner}` } });
    v.expect('руководитель получает исходные байты документа', download.status === 200 && Buffer.from(await download.arrayBuffer()).equals(pdf), '200 и исходные байты', download.status);
    await ok('POST', `/api/inbound/${receipt.id}/comments`, s.seller, { body: 'Проверим количество по упаковке', sku: 'R-1' });
    await ok('POST', `/api/inbound/${receipt.id}/comments`, s.owner, { body: 'Проверим при приёмке' });
    let card = await ok('GET', `/api/inbound/${receipt.id}`, s.seller);
    v.expect('переписка и документ находятся в том же приходе', card.comments.length === 2 && card.documents.length === 1, '2 сообщения, 1 документ', JSON.stringify({ comments: card.comments.length, documents: card.documents.length }));
    await ok('POST', `/api/receiving/session/${receipt.id}/start`, s.worker, {});
    const ri = inv.items.find((i) => i.sku === 'R-1');
    const receiveBody = { invoiceItemId: ri.id, acceptedQty: 18, placements: [{ cellBlockId: A.id, qty: 17 }],
      defect: { qty: 1, bucket: 'defective', note: 'Повреждение упаковки', cellBlockId: D.id } };
    const parallelReceipt = await Promise.all([api('POST', '/api/receiving', s.worker, receiveBody), api('POST', '/api/receiving', s.worker, receiveBody)]);
    v.expect('два одновременных принятия одной позиции: только одно успешно', parallelReceipt.filter((r) => r.status === 201).length === 1,
      'один 201, второй отказ', JSON.stringify(parallelReceipt.map((r) => ({ status: r.status, error: r.body && r.body.error }))));
    const second = inv.items.find((i) => i.sku === 'R-2');
    await ok('POST', '/api/receiving', s.worker, { invoiceItemId: second.id, acceptedQty: 8, cellBlockId: B.id });
    card = await ok('GET', `/api/inbound/${receipt.id}`, s.seller);
    v.expect('продавец видит недостачу 2 и завершённую раскладку', card.discrepancy === -2 && card.unplaced === 0, '-2 / 0', JSON.stringify({ discrepancy: card.discrepancy, unplaced: card.unplaced, status: card.status }));
    const sellerDoc = (await ok('GET', '/api/sellers/documents', s.seller)).rows.find((r) => r.id === receipt.id);
    v.expect('в документе заявлено 28, принято 26', Number(sellerDoc.declared_qty) === 28 && Number(sellerDoc.done_qty) === 26, '28 / 26', JSON.stringify({ declared: sellerDoc.declared_qty, done: sellerDoc.done_qty }));
    await stock('После прихода', [['R-1', 17, 1], ['R-2', 8, 0]]);
    const act = await ok('GET', `/api/acts/receipt/${receipt.id}`, s.seller);
    console.log('АКТ ПРИЁМКИ ' + JSON.stringify(act));
    const verdict = await Promise.all([api('POST', `/api/inbound/${receipt.id}/verdict`, s.seller, { verdict: 'agreed' }), api('POST', `/api/inbound/${receipt.id}/verdict`, s.seller, { verdict: 'agreed' })]);
    v.expect('двойное согласие с актом: один ответ', verdict.filter((r) => r.status < 300).length === 1, 'один успех', JSON.stringify(verdict.map((r) => r.status)));
    // Ручной ввод того же интерфейсного контракта, отдельный приход на «Остальной товар».
    const manual = (await ok('POST', '/api/sellers/inbound', s.seller, { grid: [['Артикул', 'Количество'], ['R-3', 2]], apply: true })).invoice;
    const md = await ok('GET', `/api/invoices/${manual.id}`, s.worker);
    await ok('POST', `/api/receiving/session/${manual.id}/start`, s.worker, {});
    await ok('POST', '/api/receiving', s.worker, { invoiceItemId: md.items[0].id, acceptedQty: 2, cellBlockId: C.id });
    // Работник заводит новый возврат на тот же виртуальный склад: 2 годных + 4 брака.
    const ret = await ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: [{ sku: 'R-1', qty: 6 }], vw: vw.id });
    const rd = await ok('GET', `/api/invoices/${ret.id}`, s.worker);
    v.expect('возврат помнит выбранный склад продавца', rd.items[0].virtual_warehouse_id === vw.id, 'выбранный склад', rd.items[0].virtual_warehouse_id === vw.id);
    await ok('POST', '/api/returns', s.worker, { invoiceItemId: rd.items[0].id, qty: 2, qualityBucket: 'good', cellBlockId: A.id });
    const rb = { invoiceItemId: rd.items[0].id, qty: 4, qualityBucket: 'defective', cellBlockId: D.id, defectNote: 'Возврат с повреждением' };
    const pr = await Promise.all([api('POST', '/api/returns', s.worker, rb), api('POST', '/api/returns', s.worker, rb)]);
    v.expect('двойная последняя сортировка возврата не удваивает брак', pr.filter((r) => r.status === 201).length === 1, 'один 201', JSON.stringify(pr.map((r) => ({ status: r.status, error: r.body && r.body.error }))));
    const viewReturn = (await ok('GET', '/api/sellers/documents', s.seller)).rows.find((r) => r.id === ret.id);
    v.expect('продавец видит возврат 2 годных и 4 брака', Number(viewReturn.good_qty) === 2 && Number(viewReturn.bad_qty) === 4, '2 / 4', JSON.stringify({ good: viewReturn.good_qty, bad: viewReturn.bad_qty }));
    await stock('После возврата', [['R-1', 19, 5], ['R-2', 8, 0], ['R-3', 2, 0]]);
    // Судьба пяти единиц: утилизация 1, возврат продавцу 1 от владельца, уценка 2, перепаковка 1.
    const disposed = await ok('POST', '/api/sellers/defects/decisions', s.seller, { sku: 'R-1', bucket: 'defective', qty: 1, action: 'dispose' });
    const back = await ok('POST', '/api/sellers/defects/decisions', s.owner, { companyId: s.company, sku: 'R-1', bucket: 'defective', qty: 1, action: 'return_to_seller', note: 'Синтетическое решение склада' });
    const marked = await ok('POST', '/api/sellers/defects/decisions', s.seller, { sku: 'R-1', bucket: 'defective', qty: 2, action: 'markdown', markdownBarcode: '2099999999001' });
    const lastBody = { sku: 'R-1', bucket: 'defective', qty: 1, action: 'repack' };
    const last = await Promise.all([api('POST', '/api/sellers/defects/decisions', s.seller, lastBody), api('POST', '/api/sellers/defects/decisions', s.seller, lastBody)]);
    v.expect('две параллельные попытки решить судьбу последней единицы: одно решение', last.filter((r) => r.status === 201).length === 1, 'один 201', JSON.stringify(last.map((r) => ({ status: r.status, error: r.body && r.body.error }))));
    const repack = last.find((r) => r.status === 201).body;
    let badView = await ok('GET', '/api/sellers/defects', s.seller);
    v.expect('по 5 единицам нет лишних нерешённых обязательств', badView.balances.find((r) => r.sku === 'R-1').undecided === 0 && badView.decisions.filter((r) => r.status === 'pending').length === 4,
      'нераспределено 0, заданий 4', JSON.stringify({ balance: badView.balances, tasks: badView.decisions.length }));
    v.expect('решение руководителя уведомляет продавца', badView.decisions.some((r) => r.id === back.id && r.unseen), 'непрочитанное решение руководителя', badView.decisions.filter((r) => r.unseen).length);
    const tasks = await ok('GET', '/api/defects/tasks', s.worker);
    v.expect('грузчик видит четыре задания по частям', tasks.length === 4, 4, tasks.length);
    const exe = await Promise.all([api('POST', `/api/defects/tasks/${disposed.id}/done`, s.worker, {}), api('POST', `/api/defects/tasks/${disposed.id}/done`, s.worker, {})]);
    v.expect('два одновременных выполнения утилизации не удваивают списание', exe.filter((r) => r.status < 300).length === 1, 'один успех', JSON.stringify(exe.map((r) => ({ status: r.status, error: r.body && r.body.error }))));
    await ok('POST', `/api/defects/tasks/${back.id}/done`, s.worker, {});
    const markdownDone = await ok('POST', `/api/defects/tasks/${marked.id}/done`, s.worker, { cellBlockId: E.id });
    await ok('POST', `/api/defects/tasks/${repack.id}/done`, s.worker, { cellBlockId: F.id });
    v.expect('повтор исполнения перепаковки отклонён', (await api('POST', `/api/defects/tasks/${repack.id}/done`, s.worker, { cellBlockId: F.id })).status === 409, 409, 'см. отдельный HTTP-ответ');
    badView = await ok('GET', '/api/sellers/defects', s.seller);
    v.expect('продавец видит все четыре решения выполненными', badView.decisions.length === 4 && badView.decisions.every((r) => r.status === 'done'), '4 done', JSON.stringify(badView.decisions.map((r) => ({ status: r.status, qty: r.qty, doneQty: r.doneQty }))));
    v.expect('выполненные задания исчезли у грузчика', (await ok('GET', '/api/defects/tasks', s.worker)).length === 0, 0, 'проверен список задач');
    for (const [decision, action] of [[disposed, 'dispose'], [back, 'return_to_seller']]) {
      const a = await ok('GET', `/api/acts/defect/${decision.id}`, s.seller);
      v.expect(`акт ${action}: 1 единица и выполнено`, a.action === action && a.items[0].qty === 1 && a.finished === true, '1 / finished', JSON.stringify({ action: a.action, qty: a.items[0].qty, finished: a.finished }));
    }
    await stock('После решений по браку', [['R-1', 20, 0], ['R-2', 8, 0], ['R-3', 2, 0], [markdownDone.toSku, 2, 0]]);
    const warehouses = await s.vwQty();
    v.expect('виртуальные склады сохранились после возврата/перепаковки/уценки', warehouses[vw.name] === 30 && warehouses['Остальной товар'] === 2,
      'Проверочный WB 30, Остальной товар 2', JSON.stringify(warehouses));
    console.log('ПОКРЫТИЕ: только API/БД; ввод файла и PDF рендеринг, браузерные состояния и печать не проверены.');
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
