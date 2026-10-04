// Только последняя миграция down1/up на своей одноразовой БД.
// Неподдерживаемые down не обходятся; источники продукта не меняются.
const cp=require('node:child_process'),path=require('node:path');
const {startApp,stand,verdicts,fail}=require('../attack-0310/_lib');
const ROOT=path.resolve(__dirname,'../..');
function migrate(direction){
 const r=cp.spawnSync(process.execPath,[path.join(ROOT,'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),direction,...(direction==='down'?['1']:[]),'-m','src/db/migrations','--no-single-transaction'],{cwd:ROOT,env:{...process.env,DATABASE_URL:process.env.ADMIN_DATABASE_URL},encoding:'utf8',windowsHide:true});
 if(r.status!==0)throw Error('Миграция '+direction+' не выполнена; код '+r.status+'; сырые логи скрыты');
}
(async()=>{
 const app=await startApp(),v=verdicts('Последняя миграция: частично выполненный брак');let down=false;
 try{
  const s=await stand(app);const[A,B,C,D]=s.cells;
  const vw=await app.ok('POST','/api/vwarehouses',s.owner,{companyId:s.company,name:'Озон',marketplace:'ozon',keepSeparate:true});
  await s.receive([{vw:vw.id,qty:5,cell:A},{qty:5,cell:B}]);
  for(const cell of[A,B])await app.ok('POST','/api/defects/moves',s.worker,{companyId:s.company,sku:'R-1',fromCellBlockId:cell.id,toCellBlockId:D.id,qty:1,bucket:'packaging_defect',source:'move'});
  const dec=await app.ok('POST','/api/sellers/defects/decisions',s.seller,{sku:'R-1',bucket:'packaging_defect',qty:2,action:'repack'});
  await app.ok('POST',`/api/defects/tasks/${dec.id}/done`,s.worker,{cellBlockId:C.id});
  const state=async()=> (await s.q('SELECT qty::int,done_qty,status FROM defect_decisions WHERE id=$1',[dec.id]))[0];
  const before=await state();
  v.expect('Подготовлено реальное частичное выполнение1из2',before.qty===2&&before.done_qty===1&&before.status==='pending','qty2 done1 pending',JSON.stringify(before));
  if(before.done_qty!==1)throw Error('Не получилось частичного выполнения');
  const stockBefore=await s.vwQty('good');
  migrate('down');down=true;migrate('up');down=false;
  const after=await state(),stockAfter=await s.vwQty('good');
  console.log('До отката: '+JSON.stringify(before));console.log('После down1/up: '+JSON.stringify(after));
  v.expect('Физический товар не меняется от миграции',JSON.stringify(stockAfter)===JSON.stringify(stockBefore),JSON.stringify(stockBefore),JSON.stringify(stockAfter));
  v.expect('Частично выполненное количество сохраняется',after.done_qty===before.done_qty,String(before.done_qty),String(after.done_qty));
  v.done();
 }finally{if(down){try{migrate('up');}catch{console.log('Возврат схемы не удался, одноразовую БД удалит runner');}}await app.stop();}
})().catch(fail);
