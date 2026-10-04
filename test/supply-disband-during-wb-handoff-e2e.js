// Одноразовая локальная БД. Весь WB — функция в памяти, ни одного внешнего запроса.
const {startApp,stand,verdicts,fail}=require('./attack-0310/_lib');
(async()=>{const a=await startApp();const v=verdicts('Разбор поставки во время передачи WB');let release;
try{
 const s=await stand(a);await s.receive([{qty:10,cell:s.cells[0]}]);
 let entered;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const remote={created:0,orders:[]};
 global.fetch=async(input,opts={})=>{
  const u=new URL(String(input));if(!u.hostname.endsWith('.wildberries.ru'))throw Error('Внешняя сеть запрещена');
  const p=u.pathname,m=opts.method||'GET';const json=x=>new Response(JSON.stringify(x),{status:200,headers:{'Content-Type':'application/json'}});
  if(p==='/api/v1/seller-info')return json({name:'Синтетический WB',tin:'0000000000',sid:'test'});
  if(p==='/api/v3/supplies'&&m==='POST'){remote.created++;entered();await gate;return json({id:'WB-GI-REVIEW'});}
  if(p==='/api/marketplace/v3/supplies/WB-GI-REVIEW/orders'){remote.orders.push(...JSON.parse(opts.body).orders);return json({});}
  if(p==='/api/v3/orders/stickers')return json({stickers:[]});
  throw Error('Непредусмотренный поддельный WB: '+m+' '+p);
 };
 await a.ok('POST','/api/marketplaces/credentials',s.owner,{companyId:s.company,marketplace:'wb',token:'test-only-wb-key'});
 await a.ok('PATCH',`/api/marketplaces/${s.company}/wb/write`,s.owner,{enabled:true});
 const inv=await a.ok('POST','/api/invoices',s.owner,{companyId:s.company,number:'WB-CONCURRENT',direction:'out',items:[{sku:'R-1',name:'Резинки чёрные',declaredQty:1}]});
 await s.q("UPDATE invoices SET source='wb',external_id='991000001',mp_supplier_status='new' WHERE id=$1",[inv.id]);
 await s.q("UPDATE invoice_items SET mp_rid='test-handoff-rid' WHERE invoice_id=$1",[inv.id]);
 const pending=a.api('POST','/api/supplies',s.manager,{invoiceIds:[inv.id],marketplace:'wb'});
 let timeout;await Promise.race([reached,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Передача WB не началась')),5000);})]);clearTimeout(timeout);
 const list=await a.ok('GET','/api/supplies',s.manager);const supply=list.find(x=>x.companyId===s.company)||list[0];
 if(!supply?.id)throw Error('Поставка ещё не видна в API');
 const cancel=await a.api('DELETE','/api/supplies/'+supply.id,s.manager);
 release();const created=await pending;
 const read=await a.api('GET','/api/supplies/'+supply.id,s.manager);
 const order=(await s.q('SELECT supply_id,mp_supplier_status FROM invoices WHERE id=$1',[inv.id]))[0];
 console.log(JSON.stringify({cancelStatus:cancel.status,createStatus:created.status,readStatus:read.status,remote,order},null,2));
 v.expect('Разобрать нельзя, пока передача WB уже началась',cancel.status===409,'409',cancel.status);
 v.expect('У принятой WB поставки сохраняется местная запись',remote.created===1&&read.status===200,'GET 200',read.status);
 v.expect('Подтверждённый WB заказ связан с местной поставкой',order.supply_id===supply.id,'supply_id сохранён',order.supply_id);
 v.done();
}catch(e){fail(e);}finally{release?.();await a.stop();}})();
