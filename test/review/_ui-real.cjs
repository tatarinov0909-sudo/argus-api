const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright');
const {realFetch}=require('../attack-0310/_lib');
const ROOT='C:/Users/tatar/Desktop/argus-review';
const SITE='C:/Users/tatar/Desktop/argus-handoff/wt-product';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};
async function openCabinet(browser,app,token,role,width,record){
 const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.origin==='http://argus.test'){
   const f=path.resolve(SITE,'.'+decodeURIComponent(u.pathname)),rel=path.relative(SITE,f);
   if(rel.startsWith('..')||path.isAbsolute(rel)||!mime[path.extname(f)]||!fs.existsSync(f))return route.fulfill({status:404,body:''});
   return route.fulfill({status:200,body:fs.readFileSync(f),contentType:mime[path.extname(f)]});
  }
  if(u.origin!=='https://api.argus-ai.online'){record.blocked.add(u.origin);return route.abort();}
  const cors={'access-control-allow-origin':'http://argus.test','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS'};
  if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors,body:''});
  const headers={};for(const name of ['authorization','content-type'])if(req.headers()[name])headers[name]=req.headers()[name];
  const res=await realFetch(app.base+u.pathname+u.search,{method:req.method(),headers,body:req.postDataBuffer()||undefined});
  record.requests.push({role,width,method:req.method(),path:u.pathname,status:res.status});
  await route.fulfill({status:res.status,headers:{...cors,'content-type':res.headers.get('content-type')||'application/json'},body:Buffer.from(await res.arrayBuffer())});
 });
 await context.addInitScript(([t,r])=>{localStorage.setItem('argus_token',t);localStorage.setItem('argus_role',r)},[token,role]);
 const page=await context.newPage();
 page.on('pageerror',e=>record.errors.push({role,width,error:e.message}));
 await page.goto('http://argus.test/cabinet_main.html');
 await page.locator(role==='manager'?'#view-orders.active':'#view-chat.active').waitFor();
 await page.evaluate(()=>document.fonts.ready);
 return {context,page};
}
async function capture(page,name,record,{last=null,screenshot=true}={}){
 await page.waitForTimeout(300);
 const m=await page.evaluate(()=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
  const css=getComputedStyle(document.body);
  return {width:innerWidth,root:document.documentElement.scrollWidth,body:document.body.scrollWidth,
   font:css.fontFamily,tabular:css.fontVariantNumeric,fontLoaded:document.fonts.check('16px "Golos Text"'),
   selects:[...document.querySelectorAll('select')].filter(visible).map(e=>({id:e.id,width:e.getBoundingClientRect().width,appearance:getComputedStyle(e).appearance})),
   internalScroll:[...document.querySelectorAll('*')].filter(e=>visible(e)&&e.scrollWidth>e.clientWidth+3&&['auto','scroll'].includes(getComputedStyle(e).overflowX)).map(e=>({id:e.id,cls:e.className,width:e.clientWidth,scroll:e.scrollWidth})),
   overflow:[...document.querySelectorAll('input,select,button,table,.staff-row,.wh-side,.sp-key,.sp-vw-form,.wh-cell-item-name,.wh-cell-item-qty')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+2||r.left< -2}).map(e=>({tag:e.tagName,id:e.id,cls:e.className,left:Math.round(e.getBoundingClientRect().left),right:Math.round(e.getBoundingClientRect().right)}))};
 });
 m.name=name;
 const masks=[page.locator('.staff-key'),page.locator('#whCodeChip'),page.locator('#wbWhBody code'),page.locator('.company-key-text')];
 if(screenshot){m.screenshot=`${ROOT}/${name}.png`;await page.screenshot({path:m.screenshot,mask:masks});}
 if(last&&await page.locator(last).count()){
  const el=page.locator(last).last();await el.scrollIntoViewIfNeeded();
  m.last=await el.evaluate(e=>{const r=e.getBoundingClientRect();const x=Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.bottom-2));const hit=document.elementFromPoint(x,y);return {selector:e.id||e.className,top:r.top,bottom:r.bottom,right:r.right,viewport:innerHeight,reachable:r.top>=-1&&r.bottom<=innerHeight+1&&r.right<=innerWidth+1,uncovered:!!hit&&(e===hit||e.contains(hit)),text:e.textContent.trim().slice(-90)}});
  if(screenshot){m.lastScreenshot=`${ROOT}/${name}-last.png`;await page.screenshot({path:m.lastScreenshot,mask:masks});}
 }
 record.states.push(m);console.log(`${name}: root=${m.root}/${m.width}; last=${m.last?JSON.stringify({reachable:m.last.reachable,uncovered:m.last.uncovered}):'-'}; selects=${m.selects.map(e=>e.id).join(',')}`);
 return m;
}
module.exports={chromium,ROOT,openCabinet,capture};
