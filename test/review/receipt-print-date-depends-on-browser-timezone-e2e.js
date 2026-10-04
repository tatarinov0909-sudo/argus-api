// Один акт склада печатается разными датами на компьютерах с разным часовым поясом.
const {startApp,stand,verdicts,fail}=require('../attack-0310/_lib');
const {chromium}=require('C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright');
const ROOT='C:/Users/tatar/Desktop/argus-review';
(async()=>{const app=await startApp(),v=verdicts('Дата акта зависит от браузера');let browser;
try{
 const s=await stand(app);await app.ok('PATCH','/api/warehouses/me',s.owner,{timezone:'Asia/Yekaterinburg'});
 const inv=await app.ok('POST','/api/invoices',s.owner,{companyId:s.company,number:'ТЕСТ-АКТ-ДАТЫ',items:[{sku:'R-1',name:'Проверка даты',declaredQty:1}]});
 await s.q('UPDATE invoices SET created_at=$2 WHERE id=$1',[inv.id,'2026-10-03T22:30:00Z']);
 const act=await app.ok('GET','/api/acts/receipt/'+inv.id,s.owner);
 const expected=new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Yekaterinburg'}).format(new Date(act.date));
 browser=await chromium.launch({headless:true,channel:'chrome',proxy:{server:'http://127.0.0.1:9',bypass:'127.0.0.1,localhost'},args:['--disable-background-networking','--disable-sync']});
 const dates=[];
 for(const zone of ['Europe/Moscow','America/Los_Angeles']){
  const c=await browser.newContext({timezoneId:zone,viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await c.route('**/*',async r=>{const u=new URL(r.request().url());if(u.origin==='http://127.0.0.1:3010')return r.fulfill({response:await r.fetch({url:app.base+u.pathname+u.search})});if(u.origin==='http://127.0.0.1:8099')return r.continue();return r.abort();});await c.routeWebSocket('**/*',s=>s.close());
  await c.addInitScript(t=>{localStorage.setItem('argus_token',t);localStorage.setItem('argus_role','owner');},s.owner);
  const p=await c.newPage();await p.goto('http://127.0.0.1:8099/act_print.html?kind=receipt&id='+inv.id);await p.locator('#sheet h1').waitFor();
  const title=await p.locator('#sheet h1').innerText();dates.push(title.match(/от (\d{2}\.\d{2}\.\d{4})/)?.[1]);console.log(JSON.stringify({browserTimezone:zone,warehouseTimezone:'Asia/Yekaterinburg',expected,printed:dates.at(-1)}));
  v.expect('дата по поясу склада при браузере '+zone,dates.at(-1)===expected,expected,dates.at(-1));
  await p.screenshot({path:ROOT+'/screenshots/receipt-date-'+zone.replaceAll('/','-')+'-'+Date.now()+'.png',fullPage:true});await c.close();
 }
 v.expect('один акт имеет одинаковую дату у двух пользователей',dates[0]===dates[1],dates[0],dates[1]);
}catch(e){fail(e);}finally{v.done();if(browser)await browser.close();await app.stop();}})();
