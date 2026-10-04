const fs=require('node:fs');
const {startApp,stand,verdicts,fail}=require('../attack-0310/_lib');
const {chromium,ROOT,openCabinet}=require('./_ui-real.cjs');
const suffix=new URL(process.env.DATABASE_URL).pathname.split('_').at(-1);
(async()=>{
 const app=await startApp();let browser;const record={run:suffix,requests:[],errors:[],blocked:new Set(),widths:[]};
 const v=verdicts('Числа пересчёта доступны на телефоне');
 try{
  const s=await stand(app,{skus:[['I-1','Товар']],racks:1});
  await s.receive([{qty:100000,cell:s.cells[0]}]);
  const id=await s.run(async c=>{const r=await c.query('INSERT INTO inventory_runs(warehouse_id) VALUES($1) RETURNING id',[s.warehouseId]);return(await c.query("INSERT INTO inventory_tasks(run_id,warehouse_id,cell_block_id,reason) VALUES($1,$2,$3,'проверка') RETURNING id",[r.rows[0].id,s.warehouseId,s.cells[0].id])).rows[0].id;});
  const opened=await app.ok('POST',`/api/inventory/tasks/${id}/open`,s.worker);
  await app.ok('POST',`/api/inventory/tasks/${id}/count`,s.worker,{snapshotId:opened.snapshotId,lines:[{sku:'I-1',companyId:s.company,quality:'good',qty:99999}]});
  browser=await chromium.launch({headless:true,channel:'chrome'});
  for(const width of [375,1440]){
   const {context,page}=await openCabinet(browser,app,s.owner,'owner',width,record);
   await page.evaluate(()=>switchView('inv'));await page.locator('.inv-diff-nums').waitFor();await page.waitForTimeout(250);
   const data=await page.locator('.inv-diff-nums').evaluate(e=>{
    const r=e.getBoundingClientRect(),last=e.querySelector('.down'),d=last.getBoundingClientRect();const ancestors=[];
    for(let p=e.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),q=p.getBoundingClientRect();if(p.scrollWidth>p.clientWidth||['hidden','auto','scroll'].includes(s.overflowX))ancestors.push({tag:p.tagName,id:p.id,cls:p.className,left:q.left,right:q.right,client:p.clientWidth,scroll:p.scrollWidth,overflowX:s.overflowX});}
    return {width:innerWidth,root:document.documentElement.scrollWidth,text:e.textContent,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},delta:{left:d.left,right:d.right,text:last.textContent},ancestors,fontLoaded:document.fonts.check('16px "Golos Text"')};
   });
   data.screenshot=`${ROOT}/inventory-mobile-${suffix}-${width}.png`;await page.screenshot({path:data.screenshot});record.widths.push(data);
   v.expect(`${width}: root не создаёт горизонтальную прокрутку`,data.root===width,width,data.root);
   v.expect(`${width}: количество и разница полностью видимы`,data.rect.left>=0&&data.rect.right<=width,`правая граница <=${width}`,data.rect.right);
   v.expect(`${width}: значение −1 видно до решения о пересчёте`,data.delta.left>=0&&data.delta.right<=width,`правая граница <=${width}`,data.delta.right);
   console.log(JSON.stringify({width,text:data.text,right:data.rect.right,delta:data.delta,ancestors:data.ancestors}));
   await context.close();
  }
  v.done();
 }finally{record.blocked=[...record.blocked];fs.writeFileSync(`${ROOT}/inventory-mobile-${suffix}.json`,JSON.stringify(record,null,2));if(browser)await browser.close();await app.stop();}
})().catch(fail);
