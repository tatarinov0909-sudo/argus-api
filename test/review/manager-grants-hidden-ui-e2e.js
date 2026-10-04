// Независимое воспроизведение: настоящая одноразовая БД/API/JWT и кабинет
// wt-product в Chrome. Все сетевые запросы браузера перехватываются.
// exit 1 — дефект продукта, exit 2 — сбой проверки. Секреты не выводятся.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ARGUS_PLAYWRIGHT_MODULE || 'C:/Users/tatar/AppData/Local/hermes/hermes-agent/node_modules/playwright');
const { startApp, stand, verdicts, fail, realFetch } = require('../attack-0310/_lib');
const ROOT = 'C:/Users/tatar/Desktop/argus-review';
const SITE = path.resolve(__dirname, '../../../argus-handoff/wt-product');
const suffix = new URL(process.env.DATABASE_URL).pathname.split('_').at(-1);
const grants = ['clients', 'staff', 'marketplaces', 'integration'];
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.woff':'font/woff', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon' };

async function openCabinet(browser, app, token, role, requests) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.origin === 'http://argus.test') {
      const f = path.resolve(SITE, '.' + decodeURIComponent(u.pathname));
      const rel = path.relative(SITE, f);
      if (rel.startsWith('..') || path.isAbsolute(rel) || !mime[path.extname(f)] || !fs.existsSync(f)) return route.fulfill({ status:404, body:'' });
      return route.fulfill({ status:200, body:fs.readFileSync(f), contentType:mime[path.extname(f)] });
    }
    if (u.origin !== 'https://api.argus-ai.online') return route.abort();
    const cors = { 'access-control-allow-origin':'http://argus.test', 'access-control-allow-headers':'authorization,content-type', 'access-control-allow-methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({status:204,headers:cors,body:''});
    const incoming = req.headers(), headers = {};
    for (const name of ['authorization','content-type']) if(incoming[name]) headers[name]=incoming[name];
    const res = await realFetch(app.base + u.pathname + u.search, { method:req.method(), headers, body:req.postDataBuffer() || undefined });
    requests.push({role,method:req.method(),path:u.pathname,status:res.status});
    await route.fulfill({status:res.status,headers:{...cors,'content-type':res.headers.get('content-type') || 'application/json'},body:Buffer.from(await res.arrayBuffer())});
  });
  await context.addInitScript(([t,r]) => { localStorage.setItem('argus_token',t); localStorage.setItem('argus_role',r); },[token,role]);
  const page = await context.newPage();
  await page.goto('http://argus.test/cabinet_main.html');
  await page.locator(role === 'manager' ? '#view-orders.active' : '#view-chat.active').waitFor();
  return {context,page};
}

(async () => {
  const app = await startApp();
  let browser;
  const v=verdicts('Четыре права менеджера и скрытое меню');
  const record={run:suffix,grants,api:[],browserRequests:[]};
  try {
    const s=await stand(app,{managerGrants:grants});
    const claims=JSON.parse(Buffer.from(s.manager.split('.')[1],'base64url').toString('utf8'));
    v.expect('Новый вход выдаёт все четыре права в подписанном сервером JWT', grants.every(g=>claims.grants.includes(g)),grants.join(','),(claims.grants||[]).join(','));
    const probes=[
      ['clients','GET','/api/sellers/1c-counterparties'],
      ['staff','GET','/api/staff'],
      ['marketplaces','PUT','/api/marketplaces/wb/offices',{ids:['111'],on:false}],
      ['integration','GET','/api/sync/keys'],
    ];
    for(const [grant,method,url,body] of probes){
      const result=await app.api(method,url,s.manager,body);
      record.api.push({grant,method,path:url,status:result.status});
      console.log(`API ${grant}: ${method} ${url} => ${result.status}`);
      v.expect(`${grant}: сервер разрешает операцию`,result.status===200,'HTTP 200',`HTTP ${result.status}`);
    }
    browser=await chromium.launch({headless:true,channel:'chrome'});
    const owner=await openCabinet(browser,app,s.owner,'owner',record.browserRequests);
    for(const id of ['nav-mp','nav-staff','nav-1c']) v.expect(`Контроль владельца: ${id} виден`,await owner.page.locator('#'+id).isVisible(),'виден','скрыт');
    await owner.page.locator('#nav-staff').click();
    await owner.page.locator('#managersToggle').click();
    const managerRow=owner.page.locator('#managerRows .staff-row').filter({has:owner.page.locator('.staff-name').filter({hasText:'Оля'})});
    await managerRow.getByRole('button',{name:'Права',exact:true}).click();
    const checked=await owner.page.locator('#managerRows .staff-edit:not([hidden]) input[data-grant]:checked').evaluateAll(els=>els.map(el=>el.dataset.grant));
    record.ownerCheckedGrants=checked;
    v.expect('Владелец видит четыре включённых флажка',grants.every(g=>checked.includes(g)) && checked.length===4,grants.join(','),checked.join(','));
    await owner.page.screenshot({path:`${ROOT}/manager-grants-${suffix}-owner.png`,fullPage:true,mask:[owner.page.locator('.staff-key'),owner.page.locator('#whCodeChip')]});
    const manager=await openCabinet(browser,app,s.manager,'manager',record.browserRequests);
    record.managerMenu=await manager.page.locator('.nav-item').evaluateAll(els=>els.map(el=>({id:el.id,text:el.textContent.trim()})));
    record.missing=[];
    for(const [id,label] of [['nav-mp','Продавцы и площадки'],['nav-staff','Сотрудники'],['nav-1c','Подключение 1С']]){
      const count=await manager.page.locator('#'+id).count();
      const visible=count>0 && await manager.page.locator('#'+id).isVisible();
      if(!visible) record.missing.push(id);
      v.expect(`Менеджеру доступен пункт «${label}» по выданному праву`,visible,'существует и виден',`элементов в DOM: ${count}`);
    }
    await manager.page.screenshot({path:`${ROOT}/manager-grants-${suffix}-manager.png`,fullPage:true,mask:[manager.page.locator('.staff-key'),manager.page.locator('#whCodeChip')]});
    console.log('Пункты менеджера: '+record.managerMenu.map(x=>x.id).join(', '));
    console.log('Флажки владельца: '+checked.join(', '));
    fs.writeFileSync(`${ROOT}/manager-grants-${suffix}-evidence.json`,JSON.stringify(record,null,2));
    v.done();
  } finally { if(browser) await browser.close(); await app.stop(); }
})().catch(fail);
