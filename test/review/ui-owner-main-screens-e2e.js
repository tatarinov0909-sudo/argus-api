const {startApp,stand,fail}=require('../attack-0310/_lib');
const {chromium}=require('C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright');
const fs=require('node:fs');const ROOT='C:/Users/tatar/Desktop/argus-review';
(async()=>{const a=await startApp();let browser;try{
 const name=('Очень длинное название товара для проверки экрана склада, упаковка большая. ').repeat(4).slice(0,260);
 const s=await stand(a,{skus:[['UI-100000',name]],racks:3});await s.receive([{sku:'UI-100000',qty:100000,cell:s.cells[0]}]);
 const ids=[];
 for(let i=0;i<28;i++){
  const inv=await a.ok('POST','/api/invoices',s.owner,{companyId:s.company,number:'WB-ЭКРАН-'+(i+1),direction:'out',items:[{sku:'UI-100000',name,declaredQty:i===27?100000:1}]});
  await s.q("UPDATE invoices SET source='wb',external_id=$2,mp_supplier_status='new' WHERE id=$1",[inv.id,String(993000001+i)]);
  await s.q("UPDATE invoice_items SET mp_rid=$2 WHERE invoice_id=$1",[inv.id,'test-ui-'+i]);ids.push(inv.id);
 }
 const supply=await a.ok('POST','/api/supplies',s.manager,{invoiceIds:ids.slice(0,3),marketplace:'wb'});
 // Синтетический ответ закрытия WB для проверки страницы сверки, без реальной сети.
 await s.q("UPDATE invoices SET mp_closed_at=now(),mp_close_reason='canceled',mp_supplier_status='cancel' WHERE id=$1",[ids[0]]);
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const all=[];const stamp=Date.now();fs.mkdirSync(ROOT+'/screenshots/owner-main',{recursive:true});
 for(const width of [375,1440]){
  const ctx=await browser.newContext({viewport:{width,height:1000}});
  await ctx.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname==='127.0.0.1'&&u.port==='3010')return r.fulfill({response:await r.fetch({url:a.base+u.pathname+u.search})});if(u.hostname==='127.0.0.1'&&u.port==='8099')return r.continue();return r.abort();});
  await ctx.addInitScript(t=>{localStorage.setItem('argus_token',t);localStorage.setItem('argus_role','owner');},s.owner);
  const p=await ctx.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
  async function capture(state){await p.waitForTimeout(300);const metrics=await p.evaluate(()=>{
   const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
   const els=[...document.querySelectorAll('body *')].filter(visible);
   const active=document.querySelector('.view.active')||document.querySelector('main')||document.body;
   return{width:innerWidth,rootWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,font:getComputedStyle(document.body).fontFamily,
    visibleNativeSelect:els.filter(e=>e.tagName==='SELECT').map(e=>e.id),
    overRight:els.filter(e=>e.getBoundingClientRect().right>innerWidth+2&&!e.closest('.sidebar')).slice(0,15).map(e=>({tag:e.tagName,id:e.id,cls:e.className,right:Math.round(e.getBoundingClientRect().right),overflow:getComputedStyle(e).overflowX})),
    text:active.innerText.slice(0,2500),numbers:els.filter(e=>e.childElementCount===0&&/^\s*\d[\d\s,.]*\s*$/.test(e.textContent)).slice(0,8).map(e=>({text:e.textContent,font:getComputedStyle(e).fontFamily,numeric:getComputedStyle(e).fontVariantNumeric})),
    orderTable:[...document.querySelectorAll('.ord-scroll')].filter(visible).map(e=>({visibleWidth:e.clientWidth,contentWidth:e.scrollWidth})),
    scrollables:els.filter(e=>e.scrollHeight>e.clientHeight+20&&['auto','scroll'].includes(getComputedStyle(e).overflowY)).map(e=>({id:e.id,cls:e.className,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}))};});
   const file=`owner-main/${stamp}-${width}-${state}.png`;await p.screenshot({path:ROOT+'/screenshots/'+file});
   all.push({state,width,file,metrics,errors:[...errors]});console.log(state+' '+width+': root='+metrics.rootWidth+', errors='+errors.length);
  }
  await p.goto('http://127.0.0.1:8099/cabinet_main.html');await p.waitForTimeout(450);
  for(const view of ['orders','supplies','journal','billing','chat']){
   await p.evaluate(v=>switchView(v),view);await p.waitForTimeout(400);await capture(view);
   if(view==='orders'){
    const el=p.locator('[onclick^="pickOrdersPartner("]').first();if(await el.count()){await el.click();await capture('orders-expanded');}
   }
   if(view==='supplies'){
    const el=p.locator('[onclick^="toggleSupplyInside("]').first();if(await el.count()){await el.click();await capture('supply-detail');}
   }
   await p.evaluate(()=>{for(const e of document.querySelectorAll('body *'))if(e.scrollHeight>e.clientHeight+20&&['auto','scroll'].includes(getComputedStyle(e).overflowY))e.scrollTop=e.scrollHeight;});
   if(['orders','journal','supplies'].includes(view))await capture(view+'-bottom');
  }
  await p.goto('http://127.0.0.1:8099/marketplace-reconciliation.html');await p.waitForTimeout(400);await capture('reconciliation');
  const b=p.locator('#orders tbody button').first();if(await b.count()){await b.click();await capture('reconciliation-detail');}
  await p.goto('http://127.0.0.1:8099/login.html');await capture('login');
  for(const role of ['worker','owner','manager','seller']){await p.evaluate(r=>goForm(r),role);await capture('login-'+role);}
  await ctx.close();
 }
 fs.writeFileSync(ROOT+'/logs/ui-owner-main-'+stamp+'.json',JSON.stringify(all,null,2));
 console.log('Состояний: '+all.length);
 if(process.env.REVIEW_ASSERT_FORMATTING==='1'){
  const supply=all.find(r=>r.state==='supplies'&&r.width===375);
  const reconcile=all.find(r=>r.state==='reconciliation'&&r.width===375);
  const native=supply.metrics.visibleNativeSelect.length;
  const badFont=reconcile.metrics.numbers.filter(n=>!n.font.includes('Golos Text'));
  console.log('Фильтры поставок, видимых native SELECT: '+native+' (ожидалось 0)');
  console.log('Числа сверки не Golos Text: '+badFont.length+' (ожидалось 0)');
  if(native||badFont.length)process.exitCode=1;
 }
 if(process.env.REVIEW_ASSERT_MOBILE==='1'){
  const table=all.find(r=>r.state==='orders-expanded'&&r.width===375).metrics.orderTable[0];
  console.log('Заказы на375: '+JSON.stringify(table)+'; ожидается чтение строки без бокового прокручивания по правилу formatting.md');
  if(!table||table.contentWidth>table.visibleWidth+2)process.exitCode=1;
 }
}catch(e){fail(e);}finally{if(browser)await browser.close();await a.stop();}})();
