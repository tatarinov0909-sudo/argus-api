// Ошибка: документ брака принимает не-изображение с Content-Type image/png.
// Запуск только через argus-review/run-probe.cjs, который создаёт и удаляет БД.
const {startApp,stand,verdicts,fail,realFetch}=require('../attack-0310/_lib');
(async()=>{const app=await startApp(),v=verdicts('Фото брака принимает не-изображение');try{
 const s=await stand(app);await s.receive([{qty:2,cell:s.cells[0]}]);
 const move=await app.ok('POST','/api/defects/moves',s.worker,{companyId:s.company,sku:'R-1',fromCellBlockId:s.cells[0].id,toCellBlockId:s.cells[1].id,qty:1,bucket:'defective',source:'move'});
 const url=app.base+'/api/defects/moves/'+move.id+'/photo';
 for(const[label,body]of[['текст',Buffer.from('Это не изображение')],['обрезанный PNG',Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13])],['HTML',Buffer.from('<b>тест</b><img src=x onerror="window.__reviewXss=1">')]]){
  const response=await realFetch(url,{method:'PUT',headers:{Authorization:'Bearer '+s.worker,'Content-Type':'image/png'},body});await response.arrayBuffer();
  const stored=await realFetch(url,{headers:{Authorization:'Bearer '+s.seller}});const bytes=Buffer.from(await stored.arrayBuffer());
  console.log(JSON.stringify({label,uploadStatus:response.status,readStatus:stored.status,persistedExactly:bytes.equals(body)}));
  v.expect(label+' не должен приниматься как фотография',response.status===400,'400, файл отклонён',response.status);
 }
}catch(e){fail(e);}finally{v.done();await app.stop();}})();
