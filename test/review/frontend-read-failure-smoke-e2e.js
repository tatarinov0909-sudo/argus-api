const {startApp,stand,verdicts,fail}=require('../attack-0310/_lib');
const {chromium}=require('C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright');
(async()=>{const app=await startApp(),v=verdicts('Ошибки чтения frontend');let browser;try{
 const s=await stand(app);let inject=true;
 browser=await chromium.launch({headless:true,channel:'chrome',proxy:{server:'http://127.0.0.1:9',bypass:'127.0.0.1,localhost'},args:['--disable-background-networking','--disable-sync']});
 const c=await browser.newContext({serviceWorkers:'block'});await c.route('**/*',async r=>{const u=new URL(r.request().url());if(u.origin==='http://127.0.0.1:3010'){if(inject&&u.pathname==='/api/sellers/stock')return r.fulfill({status:503,json:{error:'Контрольная ошибка рецензии'}});return r.fulfill({response:await r.fetch({url:app.base+u.pathname+u.search})});}if(u.origin==='http://127.0.0.1:8099')return r.continue();return r.abort();});await c.routeWebSocket('**/*',s=>s.close());await c.addInitScript(t=>{localStorage.setItem('argus_token',t);localStorage.setItem('argus_role','seller');},s.seller);
 const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto('http://127.0.0.1:8099/client_access.html');await p.locator('#retryLoad').waitFor();
 v.expect('503 не подменяется пустым остатком',await p.locator('#view').innerText().then(t=>t.includes('Данные не загрузились')&&t.includes('Контрольная ошибка рецензии')),'ошибка данных и повтор','прочитан блок ошибки');
 v.expect('кнопка обновления разблокирована после ошибки',!await p.locator('#refreshButton').isDisabled(),'активная кнопка',await p.locator('#refreshButton').isDisabled());
 inject=false;await p.locator('#retryLoad').click();await p.locator('#rows').waitFor();
 v.expect('Повторить восстанавливает данные настоящего API',await p.locator('#rows').innerText().then(t=>t.includes('Резинки чёрные')),'товар виден','прочитан список товаров');
 v.expect('обработанная ошибка не вызывает pageerror',errors.length===0,'нет JS-исключений',JSON.stringify(errors));
 await p.screenshot({path:'C:/Users/tatar/Desktop/argus-review/screenshots/frontend-error-recovered-'+Date.now()+'.png',fullPage:true});
}catch(e){fail(e);}finally{v.done();if(browser)await browser.close();await app.stop();}})();
