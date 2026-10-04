// Настоящий инструмент Кладовщика и API на одной БД, без модели/ключа ИИ.
const {startApp,stand,verdicts,fail}=require('../attack-0310/_lib');
const kladovshchik=require('../../src/agents/kladovshchik');
(async()=>{
 const app=await startApp(),v=verdicts('Кладовщик: неизвестный остаток по складу');
 try{
  const s=await stand(app,{source:'1c'});
  await app.ok('POST','/api/vwarehouses',s.owner,{companyId:s.company,name:'Озон',marketplace:'ozon'});
  const owner=(await app.ok('GET',`/api/sellers/stock?companyId=${s.company}`,s.owner)).find(r=>r.sku==='R-1');
  const seller=(await app.ok('GET','/api/sellers/stock',s.seller)).rows.find(r=>r.sku==='R-1');
  const tool=await s.run(c=>kladovshchik.runTool(c,s.warehouseId,'seller_stock',{seller:'Резинки'}));
  const source=owner.byWarehouse.find(w=>w.id===null);
  const agent=tool.warehouses.find(w=>w.warehouse==='Остальной товар');
  v.expect('По товару ещё нет числа из 1С',owner.total===null&&tool.total===null,'null/null',`${owner.total}/${tool.total}`);
  v.expect('Кабинет владельца сохраняет неизвестный остаток части',source.onHand===null&&source.available===null,'null/null',`${source.onHand}/${source.available}`);
  console.log('Продавец: '+JSON.stringify({total:seller.total,warehouses:seller.warehouses}));
  console.log('Инструмент Кладовщика: '+JSON.stringify({total:tool.total,withoutStockNumber:tool.withoutStockNumber,warehouses:tool.warehouses}));
  v.expect('Кладовщик сохраняет неизвестное количество как null',agent.onHand===null,'null',agent.onHand);
  v.expect('Кладовщик сохраняет неизвестное доступное как null',agent.available===null,'null',agent.available);
  v.done();
 }finally{await app.stop();}
})().catch(fail);
