const {startApp,stand,verdicts,fail}=require('../attack-0310/_lib');
const {chromium}=require('C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright');
const ROOT='C:/Users/tatar/Desktop/argus-review';
const PAYLOAD='<b data-review-xss="1">тест</b> <img data-review-xss="1" src=x onerror="window.__reviewXss=1">';
(async()=>{const app=await startApp(),v=verdicts('XSS в кабинетах и печати');let browser;
try{
 const s=await stand(app,{skus:[['XSS-1',PAYLOAD],['=1+1','=HYPERLINK("https://example.test","тест")']]});
 await app.ok('PATCH','/api/warehouses/me',s.owner,{name:PAYLOAD,city:'<b>тест</b>',legalName:PAYLOAD});
 await app.ok('POST','/api/sellers/companies',s.owner,{name:PAYLOAD});
 await app.ok('POST','/api/staff',s.owner,{name:PAYLOAD});
 const inbound=await app.ok('POST','/api/invoices',s.owner,{companyId:s.company,number:PAYLOAD,items:[{sku:'XSS-1',name:PAYLOAD,declaredQty:3}]});
 await app.ok('POST','/api/inbound/'+inbound.id+'/comments',s.seller,{body:PAYLOAD});
 const outbound=await app.ok('POST','/api/invoices',s.owner,{companyId:s.company,number:'XSS-OUT',direction:'out',items:[{sku:'XSS-1',name:PAYLOAD,declaredQty:1}]});
 const supply=await app.ok('POST','/api/supplies',s.owner,{invoiceIds:[outbound.id],marketplace:'wb',destination:PAYLOAD,shipDate:'2026-10-04'});
 browser=await chromium.launch({headless:true,channel:'chrome',proxy:{server:'http://127.0.0.1:9',bypass:'127.0.0.1,localhost'},args:['--disable-background-networking','--disable-component-update','--disable-sync']});
 async function page(token,role,file){
  const c=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await c.route('**/*',async r=>{const u=new URL(r.request().url());if(u.origin==='http://127.0.0.1:3010')return r.fulfill({response:await r.fetch({url:app.base+u.pathname+u.search})});if(u.origin==='http://127.0.0.1:8099')return r.continue();return r.abort();});
  await c.routeWebSocket('**/*',socket=>socket.close());
  await c.addInitScript(({token,role})=>{localStorage.setItem('argus_token',token);localStorage.setItem('argus_role',role);window.__reviewXss=0;},{token,role});
  const p=await c.newPage();await p.goto('http://127.0.0.1:8099/'+file);await p.waitForTimeout(450);return p;
 }
 async function check(p,label,scope='body'){
  await p.waitForTimeout(150);
  const result=await p.locator(scope).evaluate((el,payload)=>({asText:el.textContent.includes(payload),injected:document.querySelectorAll('[data-review-xss]').length,executed:window.__reviewXss||0}),PAYLOAD);
  console.log(JSON.stringify({label,...result}));v.expect(label,result.asText&&result.injected===0&&result.executed===0,'полная строка как текст; нет DOM/выполнения',JSON.stringify(result));
 }
 const owner=await page(s.owner,'owner','cabinet_main.html');
 await owner.locator('#nav-mp').click();await check(owner,'название продавца');
 await owner.locator('#nav-staff').click();await check(owner,'имя сотрудника','#staffRows');
 await owner.locator('#nav-products').click();await owner.evaluate(id=>openSellerProducts(id),s.company);await owner.waitForTimeout(250);await check(owner,'название товара владельца','#productsList');
 await owner.locator('#nav-receipts').click();await owner.evaluate(id=>openReceipt(id),inbound.id);await owner.waitForTimeout(250);await check(owner,'номер прихода и комментарий продавца','#receiptBody');
 await owner.locator('#receiptModal .panel-close-btn').click();await owner.locator('#nav-journal').click();await check(owner,'журнал действий','#jList');
 await owner.addStyleTag({content:'.staff-key,#whToast,.sp-key code{visibility:hidden!important}'});
 await owner.screenshot({path:ROOT+'/screenshots/security-xss-owner-'+Date.now()+'.png',fullPage:true});
 const seller=await page(s.seller,'seller','client_access.html');await check(seller,'товар у продавца','#rows');
 const manager=await page(s.manager,'manager','cabinet_main.html');await manager.locator('#nav-journal').click();await check(manager,'журнал менеджера','#jList');
 const worker=await page(s.worker,'worker','loader.html');await worker.evaluate(id=>openReceipt(id),inbound.id);await worker.waitForTimeout(250);await check(worker,'приход у кладовщика','#receiptBody');
 for(const [name,url]of[['акт приёмки','act_print.html?kind=receipt&id='+inbound.id],['акт отгрузки','act_print.html?kind=shipment&id='+supply.id],['печатная поставка','supply_print.html?id='+supply.id]]){const p=await page(s.owner,'owner',url);await check(p,name);await p.screenshot({path:ROOT+'/screenshots/security-xss-print-'+name+'-'+Date.now()+'.png',fullPage:true});}
 // Logout and browser back. Clear init scripts by opening a fresh context that sets storage once only.
 const c=await browser.newContext({serviceWorkers:'block'});await c.route('**/*',async r=>{const u=new URL(r.request().url());if(u.origin==='http://127.0.0.1:3010')return r.fulfill({response:await r.fetch({url:app.base+u.pathname+u.search})});if(u.origin==='http://127.0.0.1:8099')return r.continue();return r.abort();});
 const lp=await c.newPage();await lp.goto('http://127.0.0.1:8099/login.html');await lp.evaluate(t=>{localStorage.setItem('argus_token',t);localStorage.setItem('argus_role','owner');},s.owner);await lp.goto('http://127.0.0.1:8099/cabinet_main.html');await lp.waitForTimeout(300);await lp.evaluate(()=>logout());await lp.waitForURL('**/login.html');await lp.goBack();await lp.waitForTimeout(500);
 v.expect('logout и Назад не возвращают авторизованный кабинет',lp.url().endsWith('/login.html')&&await lp.evaluate(()=>!localStorage.getItem('argus_token')),'страница входа, нет токена',new URL(lp.url()).pathname);
}catch(e){fail(e);}finally{v.done();if(browser)await browser.close();await app.stop();}})();
