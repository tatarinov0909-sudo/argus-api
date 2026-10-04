// Отзыв настоящего интеграционного ключа проверяется и вне /api/sync.
// Только одноразовая локальная БД, токены/ключи не печатаются.
const {startApp,stand,verdicts,fail}=require('../attack-0310/_lib');
(async()=>{
 const app=await startApp(),v=verdicts('Отозванный integration JWT вне sync');
 try{
  const s=await stand(app);
  const received=await s.receive([{qty:2,cell:s.cells[0]}]);
  const key=await app.ok('POST','/api/sync/keys',s.owner,{label:'Локальный тест отзыва'});
  const {token}=await app.ok('POST','/api/sync/auth',null,{keyCode:key.key_code});
  v.expect('До отзыва интеграция читает sync', (await app.api('GET','/api/sync/changes',token)).status===200,'200','не 200');
  v.expect('До отзыва интеграция читает каталог', (await app.api('GET','/api/products',token)).status===200,'200','не 200');
  const off=await app.ok('PATCH',`/api/sync/keys/${key.id}/toggle`,s.owner,{});
  v.expect('Владелец действительно отозвал ключ',off.active===false,'false',off.active);
  const login=await app.api('POST','/api/sync/auth',null,{keyCode:key.key_code});
  const sync=await app.api('GET','/api/sync/changes',token);
  v.expect('Повторный вход отозванным ключом403',login.status===403,'403',login.status);
  v.expect('Уже выпущенный JWT отклонён в sync401',sync.status===401,'401',sync.status);
  for(const url of ['/api/products','/api/invoices',`/api/invoices/${received.inv.id}`]){
   const r=await app.api('GET',url,token);
   const rows=Array.isArray(r.body)?r.body.length:r.body?.id?1:0;
   console.log(`После отзыва ${url.replace(received.inv.id,'<свой-документ>')}: HTTP ${r.status}, объектов=${rows}`);
   v.expect('Отозванный интеграционный JWT не читает '+url.replace(received.inv.id,'<свой-документ>'),r.status===401||r.status===403,'401/403',`HTTP ${r.status}, объектов ${rows}`);
  }
  v.done();
 }finally{await app.stop();}
})().catch(fail);
