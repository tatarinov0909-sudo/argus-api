// Только синтетические операции в явно выделенной argus_seller_test_* базе.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const dbName=new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if(!/^\/argus_seller_test_/.test(dbName) || process.env.ARGUS_TEST_ALLOW_WRITES!=='1') throw Error('Explicit isolated test database and ARGUS_TEST_ALLOW_WRITES=1 required');
const {createApp}=require('../src/app');
const {pool,withTenantContext}=require('../src/db/pool');
const billing=require('../src/billing/service');
const {todayIn}=require('../src/warehouses/time');
const {addDays}=require('../src/billing/values');
(async()=>{
  const server=createApp().listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(method,path,token,body,status=200)=>{
    const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const out=await r.json().catch(()=>null); assert.equal(r.status,status,`${method} ${path}: ${r.status} ${out?.error || ''}`); return out;
  };
  let passed=0; const check=label=>{passed+=1; console.log(`PASS ${label}`);};
  try {
    const register=async name=>(await api('POST','/api/auth/owner/register',null,{name,email:`billing-${randomUUID()}@example.test`,password:'test-only-password',warehouseName:name,city:'Test'},201)).token;
    const owner=await register('Биллинг тест'),stranger=await register('Другая тестовая компания');
    const wid=JSON.parse(Buffer.from(owner.split('.')[1],'base64url')).warehouseId;
    const db=(sql,args)=>withTenantContext({warehouseId:wid},c=>c.query(sql,args));
    const a=await api('POST','/api/sellers/companies',owner,{name:'Продавец А'},201),b=await api('POST','/api/sellers/companies',owner,{name:'Продавец Б'},201);
    const login=async c=>{const k=await api('POST',`/api/sellers/companies/${c.id}/keys`,owner,{},201); return (await api('POST','/api/auth/seller/login',null,{keyCode:k.key_code,name:'Тестовый продавец'})).token;};
    const sellerA=await login(a),sellerB=await login(b);
    const wk=await api('POST','/api/staff',owner,{name:'Тестовый грузчик'},201);
    const worker=(await api('POST','/api/auth/staff/login',null,{keyCode:wk.key_code})).token;
    await api('POST','/api/cells/rows',owner,{configs:[{rackCount:3,tierCount:1}]},201);
    const cells=(await api('GET','/api/cells/rows',owner)).flatMap(r=>r.blocks).map(x=>x.id);
    await db(`INSERT INTO products (warehouse_id,company_id,sku,name) VALUES ($1,$2,'BL-1','Тестовый товар')`,[wid,a.id]);
    const incoming=await api('POST','/api/invoices',owner,{companyId:a.id,number:'ПР-ТЕСТ-БИЛЛИНГ',items:[{sku:'BL-1',name:'Тестовый товар',declaredQty:10}]},201);
    await api('POST',`/api/receiving/session/${incoming.id}/start`,worker,{},201);
    await api('POST','/api/receiving',worker,{invoiceItemId:incoming.items[0].id,acceptedQty:7,placements:[{cellBlockId:cells[0],qty:4},{cellBlockId:cells[1],qty:3}]},201);
    const timezone=(await db('SELECT timezone FROM warehouses WHERE id=$1',[wid])).rows[0].timezone || 'Europe/Moscow';
    const now=todayIn(timezone),today=addDays(now,-2),yesterday=addDays(today,-1),before=addDays(today,-4),month=today.slice(0,7);
    await db(`UPDATE receiving_records SET finished_at=($2::date+time '12:00') AT TIME ZONE $3 WHERE invoice_item_id=$1`,[incoming.items[0].id,today,timezone]);
    await db('INSERT INTO billing_storage_days (warehouse_id,company_id,day,cells,units) VALUES ($1,$2,$3,2,7)',[wid,a.id,today]);
    const path=cid=>`/api/warehouses/billing/tariff?companyId=${cid}`;
    const t0=await api('GET',path(a.id),owner); assert.equal(t0.configured,false); assert.equal(t0.prices,null);
    const c0=await api('GET',`/api/warehouses/billing/charges?month=${month}`,owner);
    assert.equal(c0.sellers.length,2); assert.equal(c0.sellers.find(s=>s.companyId===a.id).total,null);
    assert.ok(c0.sellers.find(s=>s.companyId===a.id).lines.every(l=>l.missingTariff && l.amount===null));
    await api('POST','/api/warehouses/billing/invoices',owner,{companyId:a.id,from:today,to:today},409);
    assert.deepEqual(await api('GET',`/api/sellers/billing?month=${month}`,sellerA),{enabled:false});
    check('новые клиенты без выдуманных ставок; все продавцы видны для выбора, неполный расчёт не становится счётом');
    const priceBody=(cid,day,value,show=true)=>({companyId:cid,effectiveFrom:day,prices:{storage:value,receiving:value,picking:value,returns:value},storageUnit:'unit_day',showSellers:show});
    await api('PUT','/api/warehouses/billing/tariff',owner,priceBody(a.id,yesterday,'0,10'));
    await api('PUT','/api/warehouses/billing/tariff',owner,priceBody(b.id,today,'0.25',false));
    await db(`INSERT INTO billing_storage_days (warehouse_id,company_id,day,cells,units) VALUES ($1,$2,$3,1,3),($1,$2,$4,1,3),($1,$5,$6,1,3)`,[wid,a.id,yesterday,before,b.id,today]);
    await api('PUT','/api/warehouses/billing/tariff',owner,priceBody(a.id,today,'0.20'));
    const span=await api('GET',`/api/warehouses/billing/charges?companyId=${a.id}&from=${yesterday}&to=${today}`,owner);
    assert.equal(span.sellers[0].total,'3.10'); assert.equal(span.sellers[0].lines.filter(l=>l.service==='storage').length,2);
    const cb=await api('GET',`/api/warehouses/billing/charges?companyId=${b.id}&from=${today}&to=${today}`,owner); assert.equal(cb.total,'0.75');
    const old=await api('GET',`/api/warehouses/billing/charges?companyId=${a.id}&from=${before}&to=${before}`,owner); assert.equal(old.total,null);
    await api('POST','/api/warehouses/billing/invoices',owner,{companyId:a.id,from:before,to:before},409);
    check('полные персональные ставки, дата действия по операции/дню, отсутствующая история явно требует прайса');
    const future=addDays(now,1); await api('PUT','/api/warehouses/billing/tariff',owner,priceBody(a.id,future,'9.00'));
    assert.equal((await api('GET',path(a.id),owner)).prices.storage,'0.20');
    assert.equal((await api('GET',path(a.id)+`&at=${future}`,owner)).prices.storage,'9.00');
    const bill=await api('POST','/api/warehouses/billing/invoices',owner,{companyId:a.id,from:today,to:today},201);
    assert.equal(bill.total,'2.80'); assert.equal(bill.status,'unpaid');
    const repeat=await api('POST','/api/warehouses/billing/invoices',owner,{companyId:a.id,from:today,to:today},201); assert.equal(repeat.id,bill.id);
    await api('POST','/api/warehouses/billing/invoices',owner,{companyId:a.id,from:yesterday,to:today},409);
    await api('PUT','/api/warehouses/billing/tariff',owner,priceBody(a.id,today,'999.00'),409);
    assert.equal((await api('GET',`/api/warehouses/billing/invoices/${bill.id}`,owner)).total,'2.80');
    await assert.rejects(()=>db('UPDATE billing_invoices SET total_cents=0 WHERE id=$1',[bill.id]),/permission denied|нет доступа|неизменяем/i);
    check('будущий прайс не меняет сегодня; сохранённый счёт неизменяем, повтор и пересечение периодов защищены');
    const payment={amount:'0.10',paidOn:today,idempotencyKey:randomUUID(),note:'Тестовая оплата'};
    const p1=await api('POST',`/api/warehouses/billing/invoices/${bill.id}/payments`,owner,payment,201); assert.equal(p1.status,'partial'); assert.equal(p1.balance,'2.70');
    const twins=await Promise.all([1,2].map(()=>api('POST',`/api/warehouses/billing/invoices/${bill.id}/payments`,owner,payment,201)));
    assert.ok(twins.every(p=>p.paid==='0.10' && p.payments.length===1));
    await api('POST',`/api/warehouses/billing/invoices/${bill.id}/payments`,owner,{...payment,amount:'0.11'},409);
    await api('POST',`/api/warehouses/billing/invoices/${bill.id}/payments`,owner,{amount:'3.00',paidOn:today,idempotencyKey:randomUUID()},409);
    const paid=await api('POST',`/api/warehouses/billing/invoices/${bill.id}/payments`,owner,{amount:'2.70',paidOn:today,idempotencyKey:randomUUID()},201);
    assert.equal(paid.status,'paid'); assert.equal(paid.paidCents,'280'); assert.equal(paid.balance,'0.00');
    check('точные копейки, частичная и полная оплата, защита от превышения и конкурентного повтора');
    const billB=await api('POST','/api/warehouses/billing/invoices',owner,{companyId:b.id,from:today,to:today},201);
    const mine=await api('GET',`/api/sellers/billing?from=${yesterday}&to=${today}`,sellerA); assert.equal(mine.invoices[0].id,bill.id); assert.equal(mine.total,'3.10');
    await api('GET',`/api/sellers/billing/invoices/${billB.id}?companyId=${b.id}`,sellerA,undefined,404);
    assert.deepEqual(await api('GET',`/api/sellers/billing?month=${month}`,sellerB),{enabled:false});
    await api('GET',`/api/warehouses/billing/invoices/${bill.id}`,stranger,undefined,404);
    const invisible=await withTenantContext({companyId:b.id},c=>c.query('SELECT id FROM billing_invoices WHERE id=$1',[bill.id])); assert.equal(invisible.rowCount,0);
    await api('POST',`/api/warehouses/billing/invoices/${bill.id}/payments`,sellerA,payment,403);
    check('продавец только читает собственные разрешённые счета; API и RLS изолируют продавцов/склады');
    const manager=async permissions=>{const k=await api('POST','/api/staff',owner,{name:'Тестовый менеджер',kind:'manager',permissions},201); return (await api('POST','/api/auth/staff/login',null,{keyCode:k.key_code})).token;};
    const noMoney=await manager(['warehouse']),moneyManager=await manager(['billing']);
    await api('GET','/api/warehouses/billing/invoices',noMoney,undefined,403);
    const list=await api('GET',`/api/warehouses/billing/charges?month=${month}`,moneyManager); assert.equal(list.sellers.length,2);
    const page=await api('GET','/api/warehouses/billing/invoices?limit=1',owner); assert.ok(page.nextCursor);
    const page2=await api('GET',`/api/warehouses/billing/invoices?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,owner); assert.notEqual(page.items[0].id,page2.items[0].id);
    check('право billing без clients даёт выбор продавцов; пагинация счетов без дублей');
    await api('POST','/api/warehouses/billing/invoices',owner,{companyId:a.id,from:now,to:now},400);
    const sch={companyId:a.id,enabled:true,cadence:'daily',startDate:now,paymentDays:5};
    await api('PUT','/api/warehouses/billing/schedule',owner,{...sch,startDate:yesterday},400);
    const schedule=await api('PUT','/api/warehouses/billing/schedule',owner,sch); assert.equal(schedule.nextStart,now);
    assert.equal(await withTenantContext({warehouseId:wid},c=>billing.generateScheduled(c,wid)),0);
    // Эмулируем прошедший день только на тестовой базе, не включаем старые
    // периоды через пользовательский API.
    const lastClosed=addDays(now,-1);
    await db('INSERT INTO billing_storage_days (warehouse_id,company_id,day,cells,units) VALUES ($1,$2,$3,1,3)',[wid,a.id,lastClosed]);
    await db('UPDATE billing_company_settings SET next_start=$3 WHERE warehouse_id=$1 AND company_id=$2',[wid,a.id,lastClosed]);
    assert.equal(await withTenantContext({warehouseId:wid},c=>billing.generateScheduled(c,wid)),1);
    assert.equal(await withTenantContext({warehouseId:wid},c=>billing.generateScheduled(c,wid)),0);
    assert.equal((await api('GET',`/api/warehouses/billing/schedule?companyId=${a.id}`,owner)).nextStart,now);
    const disabled=await api('PUT','/api/warehouses/billing/schedule',owner,{companyId:a.id,enabled:false}); assert.equal(disabled.enabled,false);
    check('расписание начинается осознанно, не выставляет счета задним числом при включении и не дублирует завершённые периоды');
    await api('PUT','/api/warehouses/billing/tariff',owner,{...priceBody(b.id,today,'1.00'),prices:{storage:'0.001'}},400);
    await api('GET',`/api/warehouses/billing/charges?month=2026-13`,owner,undefined,400);
    await api('GET',`/api/warehouses/billing/charges?from=2026-02-30&to=${today}`,owner,undefined,400);
    await api('PUT','/api/warehouses/billing/tariff',worker,priceBody(a.id,today,'1'),403);
    check('валидация дат, полных ставок и копеек; права работника закрыты');
    const c=await api('POST','/api/sellers/companies',owner,{name:'Четыре услуги'},201);
    await api('PUT','/api/warehouses/billing/tariff',owner,priceBody(c.id,yesterday,'0.07'));
    await api('PUT','/api/warehouses/billing/tariff',owner,priceBody(c.id,today,'0.11'));
    const makeItem=async(direction,number)=>{
      const doc=(await db('INSERT INTO invoices (warehouse_id,company_id,number,direction) VALUES ($1,$2,$3,$4) RETURNING id',[wid,c.id,number,direction])).rows[0];
      return (await db(`INSERT INTO invoice_items (warehouse_id,company_id,invoice_id,sku,name,declared_qty)
        VALUES ($1,$2,$3,'BL-TEST','Тестовый товар',5) RETURNING id`,[wid,c.id,doc.id])).rows[0].id;
    };
    const ri=await makeItem('in','ПР-4УСЛУГИ'),si=await makeItem('out','ЗК-4УСЛУГИ'),zi=await makeItem('out','ЗК-НУЛЕВОЙ'),ti=await makeItem('return','ВЗ-4УСЛУГИ');
    await db(`INSERT INTO receiving_records (warehouse_id,company_id,invoice_item_id,accepted_qty,finished_at)
      VALUES ($1,$2,$3,3,($4::date+time '12:00') AT TIME ZONE $6),($1,$2,$3,2,($5::date+time '12:00') AT TIME ZONE $6)`,[wid,c.id,ri,yesterday,today,timezone]);
    await db(`INSERT INTO shipping_records (warehouse_id,company_id,invoice_item_id,picked_qty,finished_at)
      VALUES ($1,$2,$3,2,($4::date+time '12:00') AT TIME ZONE $7),($1,$2,$3,1,($5::date+time '12:00') AT TIME ZONE $7),
             ($1,$2,$6,0,($5::date+time '12:00') AT TIME ZONE $7)`,[wid,c.id,si,yesterday,today,zi,timezone]);
    await db(`INSERT INTO return_records (warehouse_id,company_id,invoice_item_id,quality_bucket,qty,finished_at)
      VALUES ($1,$2,$3,'good',1,($4::date+time '12:00') AT TIME ZONE $6),($1,$2,$3,'defective',2,($5::date+time '12:00') AT TIME ZONE $6)`,[wid,c.id,ti,yesterday,today,timezone]);
    await db('INSERT INTO billing_storage_days (warehouse_id,company_id,day,cells,units) VALUES ($1,$2,$3,2,3)',[wid,c.id,yesterday]);
    const all=(await api('GET',`/api/warehouses/billing/charges?companyId=${c.id}&from=${yesterday}&to=${today}`,owner)).sellers[0];
    const serviceTotal=key=>all.lines.filter(l=>l.service===key).reduce((sum,l)=>sum+BigInt(l.amountCents),0n);
    assert.equal(serviceTotal('receiving'),43n); assert.equal(serviceTotal('picking'),7n); assert.equal(serviceTotal('returns'),29n); assert.equal(serviceTotal('storage'),21n);
    assert.equal(all.total,'1.00'); assert.equal(all.lines.filter(l=>l.service==='receiving').length,2);
    check('все четыре реальные услуги, смена ставки внутри документа, сборка раз за заказ и отсутствие платы за нулевой отбор');
    const overdue=(await db(`INSERT INTO billing_invoices (warehouse_id,company_id,period_from,period_to,due_date,company_name,lines,total_cents)
      VALUES ($1,$2,$3,$3,$4,'Тестовый просроченный счёт','[]',100) RETURNING id`,[wid,c.id,before,yesterday])).rows[0];
    assert.equal((await api('GET',`/api/warehouses/billing/invoices/${overdue.id}`,owner)).status,'overdue');
    const foreign=await api('POST','/api/sellers/companies',stranger,{name:'Чужая тестовая компания'},201);
    await assert.rejects(()=>db(`INSERT INTO billing_company_settings (warehouse_id,company_id) VALUES ($1,$2)`,[wid,foreign.id]),e=>e.code==='23503');
    check('просроченный статус по неоплаченному остатку и составные связи компании/склада в базе');
    await db('UPDATE companies SET archived_at=now() WHERE id=$1',[b.id]);
    const archivedPaid=await api('POST',`/api/warehouses/billing/invoices/${billB.id}/payments`,owner,
      {amount:'0.75',paidOn:now,idempotencyKey:randomUUID()},201);
    assert.equal(archivedPaid.status,'paid');
    assert.equal((await api('GET',`/api/warehouses/billing/invoices?companyId=${b.id}`,owner)).items[0].id,billB.id);
    check('архивирование продавца не теряет счёт и не мешает записать поступившую оплату');
    const d=await api('POST','/api/sellers/companies',owner,{name:'Неделя с ручным счётом'},201),weekFrom=addDays(now,-7);
    await api('PUT','/api/warehouses/billing/tariff',owner,priceBody(d.id,weekFrom,'1.00'));
    await api('PUT','/api/warehouses/billing/schedule',owner,{companyId:d.id,enabled:true,cadence:'weekly',startDate:now,paymentDays:7});
    await db('UPDATE billing_company_settings SET start_date=$3,next_start=$3 WHERE warehouse_id=$1 AND company_id=$2',[wid,d.id,weekFrom]);
    await db(`INSERT INTO billing_storage_days (warehouse_id,company_id,day,cells,units)
      SELECT $1,$2,$3::date+n,1,1 FROM generate_series(0,6) n`,[wid,d.id,weekFrom]);
    await api('POST','/api/warehouses/billing/invoices',owner,{companyId:d.id,from:addDays(weekFrom,2),to:addDays(weekFrom,3)},201);
    const daily=await api('POST','/api/sellers/companies',owner,{name:'Дневной после ста месячных'},201);
    await api('PUT','/api/warehouses/billing/tariff',owner,priceBody(daily.id,lastClosed,'1.00'));
    await api('PUT','/api/warehouses/billing/schedule',owner,{companyId:daily.id,enabled:true,cadence:'daily',startDate:now,paymentDays:7});
    await db('UPDATE billing_company_settings SET next_start=$3 WHERE warehouse_id=$1 AND company_id=$2',[wid,daily.id,lastClosed]);
    await db('INSERT INTO billing_storage_days (warehouse_id,company_id,day,cells,units) VALUES ($1,$2,$3,1,2)',[wid,daily.id,lastClosed]);
    const monthlyIds=(await db(`INSERT INTO companies (warehouse_id,name) SELECT $1,'Незавершённый месяц '||n
      FROM generate_series(1,100) n RETURNING id`,[wid])).rows.map(r=>r.id);
    await db(`INSERT INTO billing_company_settings (warehouse_id,company_id,enabled,cadence,start_date,next_start)
      SELECT $1,id,true,'monthly',$3::date,$3::date FROM companies WHERE id=ANY($2::uuid[])`,[wid,monthlyIds,lastClosed]);
    assert.equal(await withTenantContext({warehouseId:wid},c=>billing.generateScheduled(c,wid)),3);
    const weeklyBills=await api('GET',`/api/warehouses/billing/invoices?companyId=${d.id}`,owner);
    assert.equal(weeklyBills.items.length,3); assert.equal(weeklyBills.items.reduce((sum,b)=>sum+BigInt(b.totalCents),0n),700n);
    assert.equal((await api('GET',`/api/warehouses/billing/schedule?companyId=${d.id}`,owner)).nextStart,now);
    const dailyBills=await api('GET',`/api/warehouses/billing/invoices?companyId=${daily.id}`,owner); assert.equal(dailyBills.items[0].total,'2.00');
    check('расписание дополняет ручной частичный период без двойной платы; сто незавершённых месяцев не мешают дневному счёту');
    console.log(`${passed} passed`);
  } catch(e) {console.error('FAIL',e.message); process.exitCode=1;}
  finally {await new Promise(r=>server.close(r)); await pool.end();}
})();
