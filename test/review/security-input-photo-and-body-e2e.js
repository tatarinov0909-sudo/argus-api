// Только собственная одноразовая БД через argus-review/run-probe.cjs.
const {startApp,stand,verdicts,fail,realFetch}=require('../attack-0310/_lib');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=','base64');
(async()=>{const app=await startApp(),v=verdicts('Фотографии и границы входного тела');
try{
 const s=await stand(app);await s.receive([{qty:3,cell:s.cells[0]}]);
 const move=await app.ok('POST','/api/defects/moves',s.worker,{companyId:s.company,sku:'R-1',fromCellBlockId:s.cells[0].id,toCellBlockId:s.cells[1].id,qty:1,bucket:'defective',source:'move'});
 async function photo(type,body){const r=await realFetch(app.base+'/api/defects/moves/'+move.id+'/photo',{method:'PUT',headers:{Authorization:'Bearer '+s.worker,'Content-Type':type},body});return {status:r.status,body:await r.json()};}
 for(const [label,type,body,expected] of [
  ['валидное PNG','image/png',PNG,200],['пустое PNG','image/png',Buffer.alloc(0),400],
  ['HTML с настоящим MIME','text/html',Buffer.from('<b>тест</b>'),400],
  ['произвольный текст под MIME image/png','image/png',Buffer.from('Это не изображение'),400],
  ['обрезанный PNG','image/png',PNG.subarray(0,12),400],
  ['HTML под MIME image/png','image/png',Buffer.from('<img src=x onerror="window.__reviewXss=1">'),400],
  ['3 MiB + 1 байт','image/png',Buffer.alloc(3*1024*1024+1,65),413],
 ]){const r=await photo(type,body);console.log(JSON.stringify({label,status:r.status,error:r.body.error||null}));v.expect(label,r.status===expected,expected,r.status);}
 await photo('image/png',PNG);
 const get=await realFetch(app.base+'/api/defects/moves/'+move.id+'/photo',{headers:{Authorization:'Bearer '+s.seller}});
 v.expect('корректное фото читается продавцом',get.status===200&&Buffer.from(await get.arrayBuffer()).equals(PNG),'200, исходные байты',get.status);
 v.expect('фото отдаётся с nosniff и no-store',get.headers.get('x-content-type-options')==='nosniff'&&get.headers.get('cache-control')==='no-store','nosniff/no-store',JSON.stringify({nosniff:get.headers.get('x-content-type-options'),cache:get.headers.get('cache-control')}));
 const noAuth=await realFetch(app.base+'/api/defects/moves/'+move.id+'/photo',{method:'PUT',headers:{'Content-Type':'image/png'},body:PNG});
 v.expect('загрузка фото без входа закрыта',noAuth.status===401,401,noAuth.status);
 for(const [label,size,expected]of[['JSON чуть меньше 5 MiB',5*1024*1024-1024,201],['JSON чуть больше 5 MiB',5*1024*1024+1024,413]]){
  const body=JSON.stringify({companyId:s.company,sku:'SIZE-'+size,name:'Тест размера',padding:'A'.repeat(size)});
  const r=await realFetch(app.base+'/api/products',{method:'POST',headers:{Authorization:'Bearer '+s.owner,'Content-Type':'application/json'},body});const d=await r.json();
  console.log(JSON.stringify({label,bytes:Buffer.byteLength(body),status:r.status,error:d.error||null}));v.expect(label,r.status===expected,expected,r.status);
 }
 const malformed=await realFetch(app.base+'/api/products',{method:'POST',headers:{Authorization:'Bearer '+s.owner,'Content-Type':'application/json'},body:'{"broken":'});
 v.expect('битый JSON даёт 400',malformed.status===400,400,malformed.status);
 const alive=await app.api('GET','/api/products',s.owner);v.expect('API доступен после некорректных тел',alive.status===200,200,alive.status);
}catch(e){fail(e);}finally{v.done();await app.stop();}})();
