// Полные персональные прайсы. Считаем только уже записанные услуги склада.
const {HttpError}=require('../middleware/errorHandler');
const {zoneOf,todayIn}=require('../warehouses/time');
const {MAX_CENTS,uuid,moneyCents,money,date,addDays,period,nextPeriod,uncoveredPeriods}=require('./values');
const SERVICES={storage:{title:'Хранение'},receiving:{title:'Приёмка',unit:'шт.'},
  picking:{title:'Сборка заказа',unit:'заказ'},returns:{title:'Разбор возврата',unit:'шт.'}};
const STORAGE_UNITS={cell_day:'ячейку в сутки',unit_day:'штуку в сутки'};

async function company(client,wid,cid,lock=false,allowArchived=false) {
  uuid(cid);
  const r=(await client.query(`SELECT id,name FROM companies WHERE warehouse_id=$1 AND id=$2${allowArchived?'':' AND archived_at IS NULL'}${lock?' FOR UPDATE':''}`,[wid,cid])).rows[0];
  if (!r) throw new HttpError(404,'Продавец не найден'); return r;
}
async function settings(client,wid,cid) {
  const r=(await client.query(`SELECT show_sellers,enabled,cadence,interval_days,to_char(start_date,'YYYY-MM-DD') AS start_date,
    to_char(next_start,'YYYY-MM-DD') AS next_start,payment_days FROM billing_company_settings WHERE warehouse_id=$1 AND company_id=$2`,[wid,cid])).rows[0];
  return {showSellers:r?.show_sellers || false,enabled:r?.enabled || false,cadence:r?.cadence || 'monthly',
    intervalDays:r?.interval_days || 30,startDate:r?.start_date || null,nextStart:r?.next_start || null,paymentDays:r?.payment_days ?? 7};
}
async function tariff(client,wid,cid=null,at=null) {
  if (!cid) return {companyRequired:true,configured:false,prices:null,showSellers:false,approximate:false,history:[],schedule:null};
  await company(client,wid,cid);
  const day=at?date(at):todayIn(await zoneOf(client,wid));
  const history=(await client.query(`SELECT id,prices,storage_unit,to_char(effective_from,'YYYY-MM-DD') AS effective_from,updated_at,updated_by
    FROM billing_company_tariffs WHERE warehouse_id=$1 AND company_id=$2 ORDER BY effective_from DESC`,[wid,cid])).rows.map(r=>({id:r.id,
    prices:Object.fromEntries(Object.entries(r.prices).map(([k,v])=>[k,money(moneyCents(v,1000000n))])),
    storageUnit:r.storage_unit,effectiveFrom:r.effective_from,updatedAt:r.updated_at,updatedBy:r.updated_by}));
  const active=history.find(r=>r.effectiveFrom<=day),s=await settings(client,wid,cid);
  return {companyId:cid,configured:!!active,prices:active?.prices || null,storageUnit:active?.storageUnit || null,
    effectiveFrom:active?.effectiveFrom || null,showSellers:s.showSellers,approximate:false,history,schedule:s};
}
async function saveTariff(client,wid,body,who) {
  const cid=body?.companyId; await company(client,wid,cid,true);
  const effectiveFrom=date(body?.effectiveFrom,'Дата начала действия'),prices={};
  for (const key of Object.keys(SERVICES)) {
    try {prices[key]=money(moneyCents(body?.prices?.[key],1000000n));}
    catch(e) {if(e instanceof HttpError) throw new HttpError(400,`Цена «${SERVICES[key].title}» — от 0 до 1 000 000, с точностью до копейки`); throw e;}
  }
  // Своё свойство, а не любое имя объекта: «constructor» иначе проходил и
  // падал в базе «внутренней ошибкой» (проверка 05.10).
  if (!Object.hasOwn(STORAGE_UNITS,String(body?.storageUnit))) throw new HttpError(400,'Хранение берём за ячейку или за штуку в сутки');
  const used=(await client.query(`SELECT 1 FROM billing_invoices b JOIN billing_company_tariffs t
    ON t.warehouse_id=b.warehouse_id AND t.company_id=b.company_id WHERE t.warehouse_id=$1 AND t.company_id=$2
    AND t.effective_from=$3::date AND b.lines @> jsonb_build_array(jsonb_build_object('tariffId',t.id::text)) LIMIT 1`,[wid,cid,effectiveFrom])).rowCount;
  if(used) throw new HttpError(409,'Этот прайс уже использован в счёте. Сохраните новую дату начала действия');
  await client.query(`INSERT INTO billing_company_tariffs (warehouse_id,company_id,effective_from,prices,storage_unit,updated_by)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (warehouse_id,company_id,effective_from) DO UPDATE
    SET prices=EXCLUDED.prices,storage_unit=EXCLUDED.storage_unit,updated_by=EXCLUDED.updated_by,updated_at=now()`,
  [wid,cid,effectiveFrom,JSON.stringify(prices),body.storageUnit,who || null]);
  await client.query(`INSERT INTO billing_company_settings (warehouse_id,company_id,show_sellers) VALUES ($1,$2,$3)
    ON CONFLICT (warehouse_id,company_id) DO UPDATE SET show_sellers=EXCLUDED.show_sellers,updated_at=now(),updated_by=$4`,
  [wid,cid,body.showSellers===true,who || null]);
  return tariff(client,wid,cid,effectiveFrom);
}
// Существующая модель: наибольшая наблюдаемая занятость за сутки.
async function snapshotStorage(client,wid,cid=null) {
  const day=todayIn(await zoneOf(client,wid));
  await client.query(`INSERT INTO billing_storage_days (warehouse_id,company_id,day,cells,units)
    SELECT $1,company_id,$2::date,count(DISTINCT cell_block_id),sum(qty) FROM cell_stock
    WHERE warehouse_id=$1 AND company_id IS NOT NULL AND qty>0 AND ($3::uuid IS NULL OR company_id=$3) GROUP BY company_id
    ON CONFLICT (warehouse_id,company_id,day) DO UPDATE SET cells=GREATEST(billing_storage_days.cells,EXCLUDED.cells),
    units=GREATEST(billing_storage_days.units,EXCLUDED.units)`,[wid,day,cid]);
}
async function charges(client,wid,options) {
  const span=period(options),cid=options.companyId || null;
  if(cid) await company(client,wid,cid);
  const zone=await zoneOf(client,wid),today=todayIn(zone);
  if(span.from<=today && span.to>=today) await snapshotStorage(client,wid,cid);
  // Границы — начало первого и конец последнего дня в поясе склада, либо
  // точные границы соседних счетов (fromAt/toAt, issueInvoice): после смены
  // пояса работа не попадает в два счёта и не выпадает из обоих (проверка 05.10).
  const p=[wid,span.from,span.to,cid,zone,options.fromAt || null,options.toAt || null];
  const lower='COALESCE($6::timestamptz,$2::date::timestamp AT TIME ZONE $5)',upper='COALESCE($7::timestamptz,($3::date+1)::timestamp AT TIME ZONE $5)';
  const during=col=>`${col}>=${lower} AND ${col}<${upper} AND ($4::uuid IS NULL OR x.company_id=$4)`;
  // День работы не выходит за период: продолжение соседнего счёта по новому
  // поясу может начаться накануне.
  const dayOf=col=>`to_char(LEAST(GREATEST((${col} AT TIME ZONE $5)::date,$2::date),$3::date),'YYYY-MM-DD')`;
  const receiving=(await client.query(`SELECT x.company_id,i.id AS document_id,i.number,
    ${dayOf('x.finished_at')} AS day,sum(x.accepted_qty)::text AS qty
    FROM receiving_records x JOIN invoice_items ii ON ii.id=x.invoice_item_id JOIN invoices i ON i.id=ii.invoice_id
    WHERE x.warehouse_id=$1 AND ${during('x.finished_at')} GROUP BY x.company_id,i.id,i.number,day ORDER BY day,i.number`,p)).rows;
  // Заказ один раз: по первой записанной сборке, а не каждой товарной строке.
  const picking=(await client.query(`SELECT x.company_id,${dayOf('x.at')} AS day,count(*)::bigint AS qty
    FROM (SELECT sr.company_id,ii.invoice_id,min(sr.finished_at) AS at FROM shipping_records sr
      JOIN invoice_items ii ON ii.id=sr.invoice_item_id WHERE sr.warehouse_id=$1 AND sr.company_id IS NOT NULL
      AND sr.finished_at IS NOT NULL AND sr.picked_qty>0 AND ($4::uuid IS NULL OR sr.company_id=$4)
      AND sr.finished_at<${upper} GROUP BY sr.company_id,ii.invoice_id) x
    WHERE ${during('x.at')} GROUP BY x.company_id,day ORDER BY day`,p)).rows;
  const returns=(await client.query(`SELECT x.company_id,i.id AS document_id,i.number,
    ${dayOf('x.finished_at')} AS day,sum(x.qty)::text AS qty
    FROM return_records x JOIN invoice_items ii ON ii.id=x.invoice_item_id JOIN invoices i ON i.id=ii.invoice_id
    WHERE x.warehouse_id=$1 AND ${during('x.finished_at')} GROUP BY x.company_id,i.id,i.number,day ORDER BY day,i.number`,p)).rows;
  const storage=(await client.query(`SELECT x.company_id,to_char(x.day,'YYYY-MM-DD') AS day,x.cells,x.units
    FROM billing_storage_days x WHERE x.warehouse_id=$1 AND x.day BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR x.company_id=$4) ORDER BY x.day`,p.slice(0,4))).rows;
  const companies=(await client.query(`SELECT id,name FROM companies WHERE warehouse_id=$1 AND archived_at IS NULL
    AND ($2::uuid IS NULL OR id=$2) ORDER BY name`,[wid,cid])).rows;
  const versions=(await client.query(`SELECT id,company_id,prices,storage_unit,to_char(effective_from,'YYYY-MM-DD') AS effective_from
    FROM billing_company_tariffs WHERE warehouse_id=$1 AND effective_from<=$2::date AND ($3::uuid IS NULL OR company_id=$3)
    ORDER BY company_id,effective_from DESC`,[wid,span.to,cid])).rows;
  const byCompany=new Map();
  for(const t of versions) {if(!byCompany.has(t.company_id)) byCompany.set(t.company_id,[]); byCompany.get(t.company_id).push(t);}
  const rows=[...storage.map(r=>({...r,service:'storage'})),...receiving.map(r=>({...r,service:'receiving'})),
    ...picking.map(r=>({...r,service:'picking'})),...returns.map(r=>({...r,service:'returns'}))];
  const buckets=new Map(companies.map(r=>[r.id,{companyId:r.id,name:r.name,groups:new Map()}]));
  for(const r of rows) {
    const s=buckets.get(r.company_id); if(!s) continue;
    const t=(byCompany.get(r.company_id) || []).find(x=>x.effective_from<=r.day),key=`${r.service}:${t?.id || 'missing'}`;
    if(!s.groups.has(key)) s.groups.set(key,{service:r.service,title:SERVICES[r.service].title,tariffId:t?.id || null,
      effectiveFrom:t?.effective_from || null,missingTariff:!t,unit:r.service==='storage'?(t?STORAGE_UNITS[t.storage_unit]:null):SERVICES[r.service].unit,
      rate:t?money(moneyCents(t.prices[r.service],1000000n)):null,qty:0,details:[]});
    const l=s.groups.get(key),qty=r.service==='storage'?(t?r[t.storage_unit==='unit_day'?'units':'cells']:null):r.qty;
    const n=qty===null?null:Number(qty);
    if(n!==null && (!Number.isSafeInteger(n) || n<0)) throw new HttpError(409,'Количество операции слишком велико');
    l.qty=n===null?null:(l.qty ?? 0)+n;
    l.details.push({label:r.number || r.day,day:r.day,documentId:r.document_id || null,qty:n,
      ...(r.service==='storage'?{cells:Number(r.cells),units:String(r.units)}:{})});
  }
  const sellers=[...buckets.values()].map(s=>{
    const lines=[...s.groups.values()].filter(l=>l.qty===null || l.qty>0).map(l=>{
      if(l.qty!==null && !Number.isSafeInteger(l.qty)) throw new HttpError(409,'Количество слишком велико');
      const cents=l.missingTariff?null:BigInt(l.qty)*moneyCents(l.rate,1000000n);
      if(cents!==null && cents>MAX_CENTS) throw new HttpError(409,'Сумма слишком велика');
      return {...l,amount:cents===null?null:money(cents),amountCents:cents===null?null:String(cents)};
    });
    const missingTariff=lines.some(l=>l.missingTariff),cents=missingTariff?null:lines.reduce((sum,l)=>sum+BigInt(l.amountCents),0n);
    return {companyId:s.companyId,name:s.name,configured:(byCompany.get(s.companyId) || []).some(t=>t.effective_from<=span.from),
      missingTariff,lines,total:cents===null?null:money(cents),totalCents:cents===null?null:String(cents)};
  });
  const missingTariff=sellers.some(s=>s.missingTariff),cents=missingTariff?null:sellers.reduce((sum,s)=>sum+BigInt(s.totalCents),0n);
  const since=(await client.query(`SELECT to_char(min(day),'YYYY-MM-DD') AS d FROM billing_storage_days
    WHERE warehouse_id=$1 AND ($2::uuid IS NULL OR company_id=$2)`,[wid,cid])).rows[0]?.d || null;
  return {...span,approximate:false,missingTariff,storageSince:since,sellers,total:cents===null?null:money(cents),totalCents:cents===null?null:String(cents)};
}
async function saveSchedule(client,wid,body,who) {
  const cid=body?.companyId; await company(client,wid,cid,true);
  if(typeof body.enabled!=='boolean') throw new HttpError(400,'Укажите, включено ли расписание');
  const current=await settings(client,wid,cid);
  if(!body.enabled) {
    await client.query(`INSERT INTO billing_company_settings (warehouse_id,company_id,enabled) VALUES ($1,$2,false)
      ON CONFLICT (warehouse_id,company_id) DO UPDATE SET enabled=false,updated_at=now(),updated_by=$3`,[wid,cid,who || null]);
    return settings(client,wid,cid);
  }
  const cadence=body.cadence;
  if(!['daily','weekly','monthly','custom'].includes(cadence)) throw new HttpError(400,'Выберите период расчётов');
  const interval=cadence==='daily'?1:cadence==='weekly'?7:cadence==='monthly'?30:Number(body.intervalDays),paymentDays=Number(body.paymentDays);
  if(!Number.isInteger(interval) || interval<1 || interval>366 || !Number.isInteger(paymentDays) || paymentDays<0 || paymentDays>366) throw new HttpError(400,'Интервал — 1–366 дней, срок оплаты — 0–366 дней');
  const startDate=date(body.startDate,'Начало расписания'),today=todayIn(await zoneOf(client,wid));
  const same=current.enabled && current.startDate===startDate && current.cadence===cadence && current.intervalDays===interval;
  if(!same && startDate<today) throw new HttpError(400,'Новое расписание начинается сегодня или позже; прошлые счета создаются вручную');
  if(!(await tariff(client,wid,cid,startDate)).configured) throw new HttpError(409,'Сначала задайте полный персональный прайс с начала расписания');
  await client.query(`INSERT INTO billing_company_settings (warehouse_id,company_id,enabled,cadence,interval_days,start_date,next_start,payment_days,updated_by)
    VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8) ON CONFLICT (warehouse_id,company_id) DO UPDATE
    SET enabled=true,cadence=$3,interval_days=$4,start_date=$5,next_start=$6,payment_days=$7,updated_by=$8,updated_at=now()`,
  [wid,cid,cadence,interval,startDate,same?current.nextStart:startDate,paymentDays,who || null]);
  return settings(client,wid,cid);
}

const FIELDS=`id,number,company_id,company_name,to_char(period_from,'YYYY-MM-DD') AS period_from,
  to_char(period_to,'YYYY-MM-DD') AS period_to,issued_at,to_char(due_date,'YYYY-MM-DD') AS due_date,lines,total_cents,
  to_char(issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
async function views(client,wid,rows) {
  const ids=rows.map(r=>r.id),zone=await zoneOf(client,wid),today=todayIn(zone);
  const payments=ids.length?(await client.query(`SELECT id,invoice_id,amount_cents,to_char(paid_on,'YYYY-MM-DD') AS paid_on,note,created_at
    FROM billing_payments WHERE warehouse_id=$1 AND invoice_id=ANY($2::uuid[]) ORDER BY paid_on,id`,[wid,ids])).rows:[];
  const byInvoice=new Map();
  for(const p of payments) {if(!byInvoice.has(p.invoice_id)) byInvoice.set(p.invoice_id,[]); byInvoice.get(p.invoice_id).push(p);}
  return rows.map(r=>{
    const pp=byInvoice.get(r.id) || [],paid=pp.reduce((sum,p)=>sum+BigInt(p.amount_cents),0n),total=BigInt(r.total_cents),balance=total-paid;
    // Порядковый номер у склада; у счетов до 05.10.2026 — прежний.
    return {id:r.id,number:r.number?`СЧ-${r.number}`:`СЧ-${r.id.slice(0,8).toUpperCase()}`,companyId:r.company_id,companyName:r.company_name,
      from:r.period_from,to:r.period_to,issuedAt:r.issued_at,dueDate:r.due_date,lines:r.lines,total:money(total),totalCents:String(total),
      paid:money(paid),paidCents:String(paid),balance:money(balance),balanceCents:String(balance),
      status:balance===0n?'paid':r.due_date<today?'overdue':paid>0n?'partial':'unpaid',
      payments:pp.map(p=>({id:p.id,amount:money(p.amount_cents),amountCents:String(p.amount_cents),paidOn:p.paid_on,note:p.note,createdAt:p.created_at}))};
  });
}
async function getInvoice(client,wid,id,cid=null) {
  uuid(id,'счёт'); if(cid) uuid(cid);
  const r=(await client.query(`SELECT ${FIELDS} FROM billing_invoices WHERE warehouse_id=$1 AND id=$2 AND ($3::uuid IS NULL OR company_id=$3)`,[wid,id,cid])).rows[0];
  if(!r) throw new HttpError(404,'Счёт не найден'); return (await views(client,wid,[r]))[0];
}
async function listInvoices(client,wid,{companyId=null,limit=30,cursor=null}={}) {
  if(companyId) await company(client,wid,companyId,false,true);
  const n=Number(limit); if(!Number.isInteger(n) || n<1 || n>100) throw new HttpError(400,'Список счетов — от 1 до 100 строк');
  let at=null,id=null;
  if(cursor) {
    try {const c=JSON.parse(Buffer.from(cursor,'base64url').toString()); at=c.at; id=uuid(c.id,'курсор');
      if(!Number.isFinite(Date.parse(at))) throw Error();} catch {throw new HttpError(400,'Неверная страница счетов');}
  }
  const rows=(await client.query(`SELECT ${FIELDS} FROM billing_invoices WHERE warehouse_id=$1 AND ($2::uuid IS NULL OR company_id=$2)
    AND ($3::timestamptz IS NULL OR (issued_at,id)<($3::timestamptz,$4::uuid)) ORDER BY issued_at DESC,id DESC LIMIT $5`,[wid,companyId,at,id,n+1])).rows;
  const visible=rows.slice(0,n),last=visible.at(-1);
  return {items:await views(client,wid,visible),nextCursor:rows.length>n?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id})).toString('base64url'):null};
}
async function issueInvoice(client,wid,body,who) {
  const cid=body?.companyId,c=await company(client,wid,cid,true),span=period(body),zone=await zoneOf(client,wid),today=todayIn(zone);
  if(span.to>=today) throw new HttpError(400,'Счёт выставляется только за завершённые дни. Сегодняшние услуги пока доступны в предварительном расчёте');
  const old=(await client.query(`SELECT id,to_char(period_from,'YYYY-MM-DD') AS f,to_char(period_to,'YYYY-MM-DD') AS t
    FROM billing_invoices WHERE warehouse_id=$1 AND company_id=$2 AND period_from<=$4::date AND period_to>=$3::date ORDER BY issued_at LIMIT 1`,[wid,cid,span.from,span.to])).rows[0];
  if(old) {if(old.f===span.from && old.t===span.to) return getInvoice(client,wid,old.id); throw new HttpError(409,'Период пересекается с уже выставленным счётом');}
  // Счёт продолжает соседний ровно с той секунды, где тот закончился, и
  // помнит свои границы (covers_*): иначе смена пояса склада переносила
  // вечерние работы в следующий счёт ещё раз или мимо обоих (проверка 05.10).
  const bounds=(await client.query(`SELECT
      COALESCE((SELECT COALESCE(covers_to,(period_to+1)::timestamp AT TIME ZONE $5) FROM billing_invoices
        WHERE warehouse_id=$1 AND company_id=$2 AND period_to=$3::date-1 ORDER BY issued_at DESC LIMIT 1),
        $3::date::timestamp AT TIME ZONE $5) AS from_at,
      COALESCE((SELECT COALESCE(covers_from,period_from::timestamp AT TIME ZONE $5) FROM billing_invoices
        WHERE warehouse_id=$1 AND company_id=$2 AND period_from=$4::date+1 ORDER BY issued_at DESC LIMIT 1),
        ($4::date+1)::timestamp AT TIME ZONE $5) AS to_at`,[wid,cid,span.from,span.to,zone])).rows[0];
  const seller=(await charges(client,wid,{...span,companyId:cid,fromAt:bounds.from_at,toAt:bounds.to_at})).sellers[0];
  if(seller.missingTariff) throw new HttpError(409,'За часть операций нет персонального прайса. Заполните ставки и дату действия');
  if(!seller.lines.length) throw new HttpError(409,'За этот период нет записанных услуг для счёта');
  const s=await settings(client,wid,cid),dueDate=body.dueDate?date(body.dueDate,'Срок оплаты'):addDays(today,s.paymentDays);
  if(dueDate<today) throw new HttpError(400,'Срок оплаты не может быть в прошлом');
  if(BigInt(seller.totalCents)>MAX_CENTS) throw new HttpError(409,'Сумма счёта слишком велика');
  // Номер — следующий у склада; замок склада — чтобы два счёта не взяли один.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing-number:'||$1::text,0))`,[wid]);
  const row=(await client.query(`INSERT INTO billing_invoices (warehouse_id,company_id,period_from,period_to,due_date,company_name,lines,total_cents,issued_by,covers_from,covers_to,number)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(SELECT COALESCE(max(number),0)+1 FROM billing_invoices WHERE warehouse_id=$1)) RETURNING id`,
  [wid,cid,span.from,span.to,dueDate,c.name,JSON.stringify(seller.lines),seller.totalCents,who || null,bounds.from_at,bounds.to_at])).rows[0];
  return getInvoice(client,wid,row.id);
}
async function recordPayment(client,wid,id,body,who) {
  uuid(id,'счёт');
  const row=(await client.query('SELECT id,company_id,total_cents FROM billing_invoices WHERE warehouse_id=$1 AND id=$2',[wid,id])).rows[0];
  if(!row) throw new HttpError(404,'Счёт не найден');
  await company(client,wid,row.company_id,true,true);
  const amount=moneyCents(body?.amount),paidOn=date(body?.paidOn,'Дата оплаты'),key=uuid(body?.idempotencyKey,'идентификатор оплаты'),note=body?.note ?? '';
  if(typeof note!=='string' || note.length>500) throw new HttpError(400,'Комментарий — до 500 символов');
  if(amount<=0n) throw new HttpError(400,'Сумма оплаты должна быть больше нуля');
  if(paidOn>todayIn(await zoneOf(client,wid))) throw new HttpError(400,'Оплата не может быть в будущем');
  const old=(await client.query(`SELECT amount_cents,to_char(paid_on,'YYYY-MM-DD') AS paid_on,note FROM billing_payments
    WHERE warehouse_id=$1 AND invoice_id=$2 AND idempotency_key=$3`,[wid,id,key])).rows[0];
  if(old) {if(BigInt(old.amount_cents)!==amount || old.paid_on!==paidOn || old.note!==note) throw new HttpError(409,'Идентификатор оплаты уже использован с другими данными'); return getInvoice(client,wid,id);}
  const paid=BigInt((await client.query('SELECT COALESCE(sum(amount_cents),0)::text AS paid FROM billing_payments WHERE warehouse_id=$1 AND invoice_id=$2',[wid,id])).rows[0].paid);
  if(paid+amount>BigInt(row.total_cents)) throw new HttpError(409,'Оплата превышает остаток по счёту');
  await client.query(`INSERT INTO billing_payments (warehouse_id,company_id,invoice_id,amount_cents,paid_on,note,idempotency_key,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[wid,row.company_id,id,String(amount),paidOn,note,key,who || null]);
  return getInvoice(client,wid,id);
}
async function generateScheduled(client,wid) {
  const today=todayIn(await zoneOf(client,wid));
  // Явное включение, максимум один завершённый период продавца за проход.
  const due=(await client.query(`SELECT s.company_id FROM billing_company_settings s JOIN companies c ON c.id=s.company_id
    WHERE s.warehouse_id=$1 AND s.enabled AND c.archived_at IS NULL AND
      CASE s.cadence WHEN 'daily' THEN s.next_start+1 WHEN 'weekly' THEN s.next_start+7
        WHEN 'custom' THEN s.next_start+s.interval_days ELSE
          (date_trunc('month',s.next_start)+interval '1 month'+
            (LEAST(extract(day FROM s.start_date)::int,
              extract(day FROM date_trunc('month',s.next_start)+interval '2 month'-interval '1 day')::int)-1)*interval '1 day')::date
      END <= $2::date
    ORDER BY s.last_attempt_at NULLS FIRST,s.next_start,s.company_id LIMIT 100`,[wid,today])).rows;
  let count=0;
  for(const r of due) {
    await client.query('SAVEPOINT scheduled_bill');
    try {
      await company(client,wid,r.company_id,true); const s=await settings(client,wid,r.company_id);
      if(!s.enabled) {await client.query('RELEASE SAVEPOINT scheduled_bill'); continue;}
      const next=nextPeriod(s.nextStart,s);
      if(next>today) {await client.query('RELEASE SAVEPOINT scheduled_bill'); continue;}
      const to=addDays(next,-1);
      const covered=(await client.query(`SELECT to_char(period_from,'YYYY-MM-DD') AS "from",to_char(period_to,'YYYY-MM-DD') AS "to"
        FROM billing_invoices WHERE warehouse_id=$1 AND company_id=$2 AND period_from<=$4::date AND period_to>=$3::date
        ORDER BY period_from`,[wid,r.company_id,s.nextStart,to])).rows;
      for(const segment of uncoveredPeriods(s.nextStart,to,covered)) {
        const span={...segment,companyId:r.company_id},seller=(await charges(client,wid,span)).sellers[0];
        if(seller.missingTariff) throw new HttpError(409,'Нет ставок для расписания');
        if(seller.lines.length) {await issueInvoice(client,wid,span,'по расписанию'); count+=1;}
      }
      await client.query('UPDATE billing_company_settings SET next_start=$3,last_attempt_at=now(),updated_at=now() WHERE warehouse_id=$1 AND company_id=$2',[wid,r.company_id,next]);
      await client.query('RELEASE SAVEPOINT scheduled_bill');
    } catch(e) {
      await client.query('ROLLBACK TO SAVEPOINT scheduled_bill'); await client.query('RELEASE SAVEPOINT scheduled_bill');
      if(!(e instanceof HttpError)) throw e;
      // Неисправный прайс одного клиента не занимает первые 100 мест навсегда.
      await client.query('UPDATE billing_company_settings SET last_attempt_at=now() WHERE warehouse_id=$1 AND company_id=$2',[wid,r.company_id]);
    }
  }
  return count;
}
module.exports={SERVICES,STORAGE_UNITS,company,tariff,saveTariff,snapshotStorage,charges,settings,saveSchedule,
  getInvoice,listInvoices,issueInvoice,recordPayment,generateScheduled};
