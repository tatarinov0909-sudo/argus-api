// Сквозной API-прогон ролей: зона + заявки + права продавца + пересчёт +
// начальные остатки. Новые сочетания с повторными/параллельными действиями.
// Браузер, парсер XLSX/CSV и печать этим тестом не проверяются.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp();
  const v = verdicts('Сценарии 4–8, сквозной API');
  try {
    const s = await stand(app, { skus: [['R-1', 'Резинки'], ['L-1', 'Для загрузки']], racks: 8 });
    const [A, B, Z, C, D] = s.cells;
    const ozon = await app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon', keepSeparate: true, zone: { cells: [Z.label] } });
    const wb = await app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'WB', marketplace: 'wb' });
    const sellerWarehouses = await app.ok('GET', '/api/vwarehouses', s.seller);
    const sellerOzon = sellerWarehouses.warehouses.find(w => w.id === ozon.id);
    v.expect('продавец видит склад без внутренней организации хранения', sellerOzon && !('zone' in sellerOzon) && !('keepSeparate' in sellerOzon),
      'Озон; без zone/keepSeparate', JSON.stringify(sellerOzon));
    const r = await s.receive([{ qty: 10, cell: A }]);
    if (r.results[0].status !== 201) throw Error('Приёмка не выполнена');
    const request = await app.ok('POST', '/api/vwarehouses/transfers', s.seller,
      { sku: 'R-1', qty: 4, fromVw: null, toVw: ozon.id });
    const entry = (await app.ok('GET', '/api/journal', s.manager)).find(e => e.entity_type === 'vw_transfer' && e.entity_id === request.id);
    if (!entry) throw Error('Менеджер не видит заявку');
    const answers = await Promise.all([
      app.api('POST', `/api/journal/${entry.id}/resolve`, s.manager, { resolution: 'confirm' }),
      app.api('POST', `/api/vwarehouses/transfers/${request.id}/decide`, s.manager, { approve: true }),
    ]);
    v.expect('параллельное выполнение заявки через два экрана — одно решение', answers.filter(x=>x.status<300).length===1 && answers.some(x=>x.status===409),
      'одно 2xx, одно 409', answers.map(x=>x.status).join(','));
    let tasks = (await app.ok('GET', '/api/vwarehouses/move-tasks', s.worker)).filter(t=>t.transfer===request.number);
    v.expect('после двойного решения создано одно задание на 4', tasks.length===1 && tasks[0].left===4, '1 задание, left4', JSON.stringify(tasks.map(t=>({left:t.left,qty:t.qty}))));
    const task=tasks[0];
    const outside = await app.api('POST', `/api/vwarehouses/move-tasks/${task.id}/step`, s.worker, { toCellBlockId: B.id, qty: 4 });
    v.expect('пока зона свободна — перенос вне зоны отклоняется', outside.status===409, '409', outside.status);
    const steps = await Promise.all([1,2].map(()=>app.api('POST', `/api/vwarehouses/move-tasks/${task.id}/step`, s.worker, { toCellBlockId: Z.id, qty: 4 })));
    v.expect('два телефона не исполняют одно задание дважды', steps.filter(x=>x.status===200).length===1 && steps.some(x=>x.status===409), '200 и 409', steps.map(x=>x.status).join(','));
    v.expect('перенос сохранил 10 штук, распределение 6+4', JSON.stringify(await s.vwQty())!=='' && (await s.vwQty())['Озон']===4 && (await s.vwQty())['Остальной товар']===6,
      'Озон4, остальной6', JSON.stringify(await s.vwQty()));
    const notifications=await app.ok('GET','/api/vwarehouses/notifications',s.seller);
    v.expect('уведомление о выполнении заявки не задвоено', notifications.filter(n=>n.entityId===request.id && n.kind==='vw_request_done').length===1,
      '1 уведомление', notifications.filter(n=>n.entityId===request.id).map(n=>n.kind).join(','));
    const rejected=await app.ok('POST','/api/vwarehouses/transfers',s.seller,{sku:'R-1',qty:2,fromVw:null,toVw:ozon.id});
    const rejectedEntry=(await app.ok('GET','/api/journal',s.manager)).find(e=>e.entity_type==='vw_transfer'&&e.entity_id===rejected.id);
    const rejections=await Promise.all([1,2].map(()=>app.api('POST',`/api/journal/${rejectedEntry.id}/resolve`,s.manager,{resolution:'rollback',note:'Нет свободной зоны сегодня'})));
    v.expect('повторный отказ менеджера — один результат',rejections.filter(x=>x.status===201).length===1&&rejections.some(x=>x.status===409),'201 и 409',rejections.map(x=>x.status).join(','));
    const rejectNotice=(await app.ok('GET','/api/vwarehouses/notifications',s.seller)).filter(n=>n.entityId===rejected.id&&n.kind==='vw_transfer_rejected');
    v.expect('продавцу одна причина отказа',rejectNotice.length===1&&rejectNotice[0].text.includes('Нет свободной зоны сегодня'),'одно уведомление с причиной',JSON.stringify(rejectNotice));
    const extra=await s.receive([{vw:ozon.id,qty:1,cell:B}]);
    v.expect('заполненная зона позволяет отдельную ячейку рядом',extra.results[0].status===201,'201',extra.results[0].status);
    const warning=(await app.ok('GET','/api/journal',s.owner)).some(e=>e.entity_type==='vw_zone'&&e.action_text.includes(B.label));
    v.expect('руководитель видит адрес товара вне заполненной зоны',warning,'запись vw_zone с адресом',String(warning));

    // Загрузка и отмена на втором артикуле, когда первый участвует в работе.
    const badRows=[{line:2,cell:C.label,sku:'L-1',qty:7,warehouse:'WB'},{line:3,cell:Z.label,sku:'L-1',qty:3,warehouse:'Остальной товар'}];
    const bad=await app.ok('POST','/api/cells/initial-stock',s.owner,{companyId:s.company,rows:badRows,apply:true});
    v.expect('ошибка зоны в одной строке отменяет весь пакет',!bad.applied&&Object.keys(await s.vwQty('good','L-1')).length===0,'ничего не загружено',JSON.stringify({applied:bad.applied,summary:bad.summary}));
    const rows=[badRows[0],{line:3,cell:D.label,sku:'L-1',qty:3,warehouse:'Остальной товар'}];
    const plan=await app.ok('POST','/api/cells/initial-stock',s.owner,{companyId:s.company,rows});
    const loaded=await app.ok('POST','/api/cells/initial-stock',s.owner,{companyId:s.company,rows,apply:true,expect:{ok:plan.summary.ok,units:plan.summary.units}});
    v.expect('загрузка распределяет 7+3 по складам',loaded.applied&&(await s.vwQty('good','L-1'))['WB']===7&&(await s.vwQty('good','L-1'))['Остальной товар']===3,'WB7, остальной3',JSON.stringify(await s.vwQty('good','L-1')));
    const undo=await Promise.all([1,2].map(()=>app.api('POST',`/api/cells/initial-stock/batches/${loaded.batch}/undo`,s.owner,{})));
    v.expect('двойная отмена одной загрузки не списывает дважды',undo.filter(x=>x.status===200).length===1&&undo.some(x=>x.status===409)&&Object.keys(await s.vwQty('good','L-1')).length===0,'200,409; остаток L=0',JSON.stringify({statuses:undo.map(x=>x.status),stock:await s.vwQty('good','L-1')}));

    await app.ok('POST','/api/vwarehouses/transfers',s.manager,{companyId:s.company,sku:'R-1',qty:2,fromVw:null,toVw:wb.id});
    await app.ok('PATCH','/api/vwarehouses/rights',s.seller,{rights:{decide:false}});
    await app.ok('POST','/api/inventory/runs',s.owner,{});
    const invTask=(await app.ok('GET','/api/inventory/tasks',s.worker)).find(t=>t.cellBlockId===A.id);
    if(!invTask)throw Error('Пересчёт исходной ячейки не назначен');
    const opened=await app.ok('POST',`/api/inventory/tasks/${invTask.id}/open`,s.worker,{});
    const countBody={snapshotId:opened.snapshotId,lines:[{sku:'R-1',companyId:s.company,quality:'good',qty:4}]};
    const count=await app.ok('POST',`/api/inventory/tasks/${invTask.id}/count`,s.worker,countBody);
    const before=await s.vwQty();
    v.expect('подсчёт ещё не меняет фактический учёт до решения руководителя',(before['Остальной товар']||0)+(before.WB||0)===6,'на двух общих складах6',JSON.stringify(before));
    const resolves=await Promise.all([1,2].map(()=>app.api('POST',`/api/inventory/tasks/${invTask.id}/resolve`,s.owner,{decision:'apply'})));
    v.expect('повторное принятие пересчёта не списывает недостачу дважды',resolves.filter(x=>x.status===200).length===1&&resolves.some(x=>x.status===409),'200 и409',resolves.map(x=>x.status).join(','));
    const decisions=await app.ok('GET','/api/vwarehouses/decisions?open=1',s.seller);
    const decision=decisions.find(d=>d.kind==='inventory');
    if(!decision)throw Error('Продавцу не задан вопрос о недостаче');
    v.expect('недостача2 сразу учтена, пока продавец выбирает распределение',Object.values(await s.vwQty()).reduce((a,b)=>a+b,0)===9,'9',JSON.stringify(await s.vwQty()));
    const chosen=decision.parts.map(p=>({vw:p.vw,qty:p.vw===wb.id?0:p.before}));
    const choices=await Promise.all([1,2].map(()=>app.api('POST',`/api/vwarehouses/decisions/${decision.id}`,s.seller,{chosen})));
    v.expect('два одинаковых решения продавца создают один перенос',choices.filter(x=>x.status===200).length===1&&choices.some(x=>x.status===409),'200 и409',choices.map(x=>x.status).join(','));
    const final=await s.vwQty();
    v.expect('по решению продавца недостача списана с WB',final['Остальной товар']===4&&(final.WB||0)===0&&final['Озон']===5,'остальной4, WB0, Озон5',JSON.stringify(final));
    const sellerStock=(await app.ok('GET','/api/sellers/stock',s.seller)).rows.find(x=>x.sku==='R-1');
    const ownerStock=(await app.ok('GET',`/api/sellers/stock?companyId=${s.company}`,s.owner)).find(x=>x.sku==='R-1');
    v.expect('остатки продавца и владельца совпадают после всей цепочки',sellerStock.total===9&&ownerStock.total===9&&JSON.stringify(sellerStock.warehouses)===JSON.stringify(ownerStock.byWarehouse),'total9; одинаковая раскладка',JSON.stringify({seller:sellerStock.total,owner:ownerStock.total}));
    console.log('Итог цепочки:',JSON.stringify({stock:final,sellerTotal:sellerStock.total,ownerTotal:ownerStock.total}));
  } catch(e){fail(e);} finally {v.done();await app.stop();}
})();
