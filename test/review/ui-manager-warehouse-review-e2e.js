// Обзор реального кабинета; синтетические данные в disposable DB, внешняя сеть закрыта.
const fs=require('node:fs');
const {startApp,stand,fail}=require('../attack-0310/_lib');
const {chromium,ROOT,openCabinet,capture}=require('./_ui-real.cjs');
const suffix=new URL(process.env.DATABASE_URL).pathname.split('_').at(-1);
const grants=['clients','staff','warehouse','integration','marketplaces','billing','shortages'];
(async()=>{
 const app=await startApp();let browser;
 const record={run:suffix,states:[],requests:[],errors:[],blocked:new Set(),managerMenus:[]};
 try{
  const longName='Товар для проверки длинного названия — '+ 'очень длинное наименование изделия '.repeat(7);
  const s=await stand(app,{skus:[['UI-LONG',longName]],racks:8,tiers:2});
  const companyName='Продавец для проверки длинного названия '+ 'синтетическое наименование '.repeat(8);
  await s.q('UPDATE companies SET name=$2 WHERE id=$1',[s.company,companyName]);
  const rows=[{line:2,cell:s.cells[0].label,sku:'UI-LONG',qty:100000,warehouse:'Остальной товар'}];
  const plan=await app.ok('POST','/api/cells/initial-stock',s.owner,{companyId:s.company,rows});
  await app.ok('POST','/api/cells/initial-stock',s.owner,{companyId:s.company,rows,apply:true,expect:{ok:plan.summary.ok,units:plan.summary.units}});
  const vw=await app.ok('POST','/api/vwarehouses',s.owner,{companyId:s.company,name:'Отдельный склад '+ 'длинное название '.repeat(4),marketplace:'ozon',keepSeparate:true,zone:{cells:[s.cells.at(-1).label]}});
  const taskId=await s.run(async c=>{const run=await c.query('INSERT INTO inventory_runs(warehouse_id) VALUES($1) RETURNING id',[s.warehouseId]);return (await c.query("INSERT INTO inventory_tasks(run_id,warehouse_id,cell_block_id,reason) VALUES($1,$2,$3,'проверка длинной строки') RETURNING id",[run.rows[0].id,s.warehouseId,s.cells[0].id])).rows[0].id;});
  const opened=await app.ok('POST',`/api/inventory/tasks/${taskId}/open`,s.worker);
  await app.ok('POST',`/api/inventory/tasks/${taskId}/count`,s.worker,{lines:[{sku:'UI-LONG',companyId:s.company,quality:'good',qty:99999}],snapshotId:opened.snapshotId});
  const workers=[];for(let i=0;i<10;i++)workers.push(await app.ok('POST','/api/staff',s.owner,{name:i===9?'Последний сотрудник — '+ 'Длинное имя '.repeat(20):`Работник ${i+1}`}));
  const tokens=[['none',s.manager]];
  for(const [name,permissions]of [['all',grants],...grants.map(g=>[g,[g]])]){
   const key=await app.ok('POST','/api/staff',s.owner,{name:`Менеджер ${name}`,kind:'manager',permissions});
   const login=await app.ok('POST','/api/auth/staff/login',null,{keyCode:key.key_code});tokens.push([name,login.token]);
  }
  browser=await chromium.launch({headless:true,channel:'chrome'});
  for(const width of [375,1440]){
   const {context,page}=await openCabinet(browser,app,s.owner,'owner',width,record);
   const snap=(n,opts)=>capture(page,`ui-${suffix}-${width}-${n}`,record,opts);
   await page.evaluate(()=>switchView('warehouse'));await page.locator('.wh-cell').first().waitFor();
   await snap('map');
   await page.evaluate(id=>openCellById(id),s.cells[0].id);await page.locator('.wh-cell-item-name').first().waitFor();
   await snap('cell-long-100000',{last:'#whCellItems .wh-cell-item-grid > :last-child'});
   await page.locator('[data-history-cell]').click();await page.waitForTimeout(500);await snap('cell-history',{last:'#jList > *'});
   await page.evaluate(()=>switchView('warehouse'));await page.evaluate(id=>openCellById(id),s.cells[1].id);await page.waitForTimeout(300);
   if(width===375)await page.evaluate(id=>toggleDefectZone(id),s.cells[1].id);
   await snap('defect-cell',{last:'#whCellDetail button'});
   await page.evaluate(()=>{closeWhDetailPanel();switchView('inv')});await page.waitForTimeout(400);
   await snap('inventory',{last:'#invMinDays'});
   await snap('inventory-discrepancy',{last:'#invWaitingList .inv-card-actions button'});
   await page.evaluate(()=>{switchView('warehouse');showPane('warehouse',0)});await page.evaluate(()=>openWhSettings());await page.locator('#whModal.open').waitFor();
   await snap('constructor',{last:'#whModal button'});await page.evaluate(()=>closeWhSettings());
   await page.evaluate(()=>openStockLoad());await page.waitForTimeout(400);await page.evaluate(id=>setStockLoadCompany(id),s.company);await page.waitForTimeout(300);
   await snap('initial-stock',{last:'.sl-batches tbody tr td:last-child'});await page.evaluate(()=>closeStockLoad());
   await page.evaluate(()=>switchView('settings'));await page.locator('#setName').waitFor();await page.waitForTimeout(300);
   await snap('settings',{last:'#view-settings button'});
   await page.locator('#setCity').fill('Казань');await page.locator('input[name="setSupplies"][value="seller"]').check();await page.evaluate(()=>saveSettings());
   record.settingsSaved=(await page.locator('#setResult').textContent()).includes('Сохранено');
   await page.evaluate(()=>switchView('staff'));await page.waitForTimeout(300);await page.evaluate(()=>{toggleStaffList(true);toggleManagersList(true)});
   await snap('staff-list',{last:'#staffRows .staff-row'});
   await page.locator('#managerRows .staff-row').filter({hasText:'Менеджер all'}).getByRole('button',{name:'Права',exact:true}).click();
   await snap('staff-rights',{last:'#managerRows .staff-edit:not([hidden]) button'});
   await page.evaluate(()=>switchView('mp'));await page.waitForTimeout(400);await page.evaluate(()=>toggleCompaniesList(true));
   await snap('sellers',{last:'.mp-card'});
   await page.evaluate(id=>openSellerPanel(id),s.company);await page.waitForTimeout(400);
   await snap('seller-window',{last:'#wbWhBody .sp-sec'});
   await page.evaluate(()=>openVwForm());await page.locator('#vwName').fill(`Новый отдельный склад ${width}`);
   await snap('vw-form',{last:'#vwSave'});
   await page.locator('#vwSave').click();await page.waitForTimeout(400);
   record.vwCreated=(await app.ok('GET',`/api/vwarehouses?companyId=${s.company}`,s.owner)).warehouses.some(x=>x.name===`Новый отдельный склад ${width}`);
   await context.close();
  }
  for(const width of [375,1440])for(const [policy,token]of tokens){
   const {context,page}=await openCabinet(browser,app,token,'manager',width,record);
   const menus=await page.locator('.nav-item').evaluateAll(els=>els.map(e=>({id:e.id,text:e.textContent.trim()})));
   record.managerMenus.push({width,policy,menus});
   if(policy==='warehouse'||policy==='all'){await page.evaluate(()=>switchView('warehouse'));await page.waitForTimeout(400);}
   if(policy==='billing'){await page.evaluate(()=>switchView('billing'));await page.waitForTimeout(400);}
   await capture(page,`ui-${suffix}-${width}-manager-${policy}`,record,{screenshot:['none','all','warehouse','billing'].includes(policy),last:policy==='billing'?'#view-billing button':null});
   await context.close();
  }
  record.longProductCharacters=longName.length;record.longCompanyCharacters=companyName.length;record.stock=100000;
 }finally{
  record.blocked=[...record.blocked];fs.writeFileSync(`${ROOT}/ui-manager-warehouse-${suffix}.json`,JSON.stringify(record,null,2));
  if(browser)await browser.close();await app.stop();
 }
})().catch(fail);
