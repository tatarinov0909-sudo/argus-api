// Обычные названия складов расширяют двухколоночную форму за пределы карточки.
const {startApp,stand,verdicts,fail}=require('../attack-0310/_lib');
const {chromium}=require('C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright');
const ROOT='C:/Users/tatar/Desktop/argus-review';
(async()=>{const app=await startApp(),v=verdicts('Форма переноса выходит за край карточки');let browser;
try{
 const s=await stand(app);const a=await app.ok('POST','/api/vwarehouses',s.owner,{companyId:s.company,name:'WB — запас для поставок',marketplace:'wb'});await app.ok('POST','/api/vwarehouses',s.owner,{companyId:s.company,name:'Озон — отдельное направление',marketplace:'ozon'});
 await s.receive([{sku:'R-1',name:'Проверочный товар',qty:1000,cell:s.cells[0],vw:a.id}]);
 browser=await chromium.launch({channel:'chrome',headless:true,proxy:{server:'http://127.0.0.1:9',bypass:'127.0.0.1,localhost'},args:['--disable-background-networking','--disable-sync']});
 for(const width of [375,1440]){
  const c=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});await c.route('**/*',async r=>{const u=new URL(r.request().url());if(u.origin==='http://127.0.0.1:3010')return r.fulfill({response:await r.fetch({url:app.base+u.pathname+u.search})});if(u.origin==='http://127.0.0.1:8099')return r.continue();return r.abort();});await c.routeWebSocket('**/*',ws=>ws.close());await c.addInitScript(token=>{localStorage.setItem('argus_token',token);localStorage.setItem('argus_role','seller');},s.seller);
  const p=await c.newPage();await p.goto('http://127.0.0.1:8099/client_access.html');await p.locator('[data-product="R-1"]').click();await p.locator('#vwMove').click();await p.locator('#vwQty').fill('1');await p.evaluate(()=>document.fonts.ready);
  const m=await p.evaluate(()=>{const b=document.querySelector('#drawerBody'),br=b.getBoundingClientRect(),fields=[...document.querySelectorAll('#vwMoveForm .field')].map(e=>{const r=e.getBoundingClientRect();return {label:e.innerText.split('\n')[0],left:r.left,right:r.right,width:r.width};});return {width:innerWidth,rootWidth:document.documentElement.scrollWidth,drawer:{left:br.left,right:br.right,width:b.clientWidth,scrollWidth:b.scrollWidth,overflowX:getComputedStyle(b).overflowX},fields};});
  console.log(JSON.stringify(m));v.expect(width+' поля целиком находятся внутри карточки',m.fields.every(f=>f.right<=m.drawer.right-1&&f.left>=m.drawer.left),'правая граница поля <= '+(m.drawer.right-1),m.fields.map(f=>[f.label,f.right]));
  await p.screenshot({path:ROOT+'/screenshots/seller-transfer-overflow-'+width+'-'+Date.now()+'.png'});await c.close();
 }
}catch(e){fail(e);}finally{v.done();if(browser)await browser.close();await app.stop();}})();
