// Чистый склад: кнопка первичной настройки не должна падать до ввода ячеек.
const {startApp,verdicts,fail}=require('../attack-0310/_lib');
const {chromium}=require('C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright');
const fs=require('node:fs');
const ROOT='C:/Users/tatar/Desktop/argus-review';
(async()=>{const app=await startApp();const v=verdicts('Конструктор нового склада');let browser;
try{
 const owner=await app.ok('POST','/api/auth/owner/register',null,{name:'Рецензия',email:'constructor-'+Date.now()+'@example.test',password:'test-only-password',warehouseName:'Новый склад проверки',city:'Казань'});
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.route('**/*',async r=>{
  const u=new URL(r.request().url());
  if(u.hostname==='127.0.0.1'&&u.port==='3010')return r.fulfill({response:await r.fetch({url:app.base+u.pathname+u.search})});
  if(u.hostname==='127.0.0.1'&&u.port==='8099')return r.continue();
  return r.abort();
 });
 await context.addInitScript(t=>{localStorage.setItem('argus_token',t);localStorage.setItem('argus_role','owner');},owner.token);
 const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto('http://127.0.0.1:8099/cabinet_main.html');
 await p.locator('#nav-warehouse').click();
 await p.locator('[onclick="openConstructor()"]').click();
 await p.waitForTimeout(250);
 const actual=await p.locator('#whConstructor').evaluate(el=>({visible:el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0,parent:el.parentElement.className,active:el.classList.contains('active')}));
 const stamp=Date.now();
 await p.screenshot({path:ROOT+'/screenshots/new-warehouse-constructor-'+stamp+'.png',fullPage:true});
 console.log(JSON.stringify({actual,errors}));
 v.expect('кнопка открыла конструктор пустого склада',actual.visible&&actual.active,'видимый конструктор',JSON.stringify(actual));
 v.expect('нажатие не вызывает JavaScript-ошибку',errors.length===0,'нет ошибок',JSON.stringify(errors));
}catch(e){fail(e);}finally{v.done();if(browser)await browser.close();await app.stop();}})();
