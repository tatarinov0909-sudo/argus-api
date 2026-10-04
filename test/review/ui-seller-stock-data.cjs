const {stand}=require('../attack-0310/_lib');
const LONG='Профессиональный набор для хранения и упаковки товаров на складе — '+('длинное русское наименование с размерами и характеристиками ').repeat(3);
async function seed(app){
 const skus=[['UI-LONG',LONG],['0000123','Артикул с ведущими нулями'],['UI-UNKNOWN','Учёт ещё не поступил'],['UI-ZERO','Товар с известным нулём'],...Array.from({length:32},(_,i)=>['UI-'+String(i+1).padStart(3,'0'),'Товар рецензии '+String(i+1).padStart(3,'0')])];
 const s=await stand(app,{skus,racks:8,tiers:1});
 await app.ok('PATCH','/api/warehouses/me',s.owner,{name:'Склад визуальной рецензии',city:'Екатеринбург',timezone:'Asia/Yekaterinburg',stockSource:'argus',wbSuppliesBy:'seller',setupDone:true});
 const a=await app.ok('POST','/api/vwarehouses',s.owner,{companyId:s.company,name:'WB — запас для поставок',marketplace:'wb'}),b=await app.ok('POST','/api/vwarehouses',s.owner,{companyId:s.company,name:'Озон — отдельное направление',marketplace:'ozon'});
 await s.receive([{sku:'UI-LONG',name:LONG,qty:100000,cell:s.cells[0],vw:null},{sku:'UI-LONG',name:LONG,qty:1000,cell:s.cells[1],vw:a.id},{sku:'UI-LONG',name:LONG,qty:200,cell:s.cells[2],vw:b.id},{sku:'0000123',name:skus[1][1],qty:5,cell:s.cells[0]},...skus.slice(4).map(([sku,name])=>({sku,name,qty:1,cell:s.cells[0]}))]);
 const zero=await app.ok('POST','/api/invoices',s.owner,{companyId:s.company,number:'НУЛЕВОЙ-ПРИХОД',items:[{sku:'UI-ZERO',name:skus[3][1],declaredQty:1}]});await app.ok('POST','/api/receiving/session/'+zero.id+'/start',s.worker,{});await app.ok('POST','/api/receiving',s.worker,{invoiceItemId:zero.items[0].id,acceptedQty:0});
 const inbound=await app.ok('POST','/api/invoices',s.owner,{companyId:s.company,number:'ПРИХОД-ДЛЯ-КОММЕНТАРИЕВ',items:[{sku:'UI-LONG',name:LONG,declaredQty:10}]});await app.ok('POST','/api/inbound/'+inbound.id+'/comments',s.seller,{body:'Проверочный комментарий продавца: прошу сверить количество и упаковку при приёмке.'});
 const order=async(number,qty)=>app.ok('POST','/api/invoices',s.owner,{companyId:s.company,number,direction:'out',items:[{sku:'UI-LONG',name:LONG,declaredQty:qty}]});
 const queued=await order('ЗАКАЗ-В-ОЧЕРЕДИ',3),assembly=await order('ЗАКАЗ-В-СБОРКЕ',7),transit=await order('ЗАКАЗ-В-ПУТИ',4);
 const supply=await app.ok('POST','/api/supplies',s.owner,{invoiceIds:[assembly.id],marketplace:'wb',destination:'Тестовый пункт назначения поставки',shipDate:'2026-10-05',virtualWarehouseId:a.id});
 const departed=await app.ok('POST','/api/supplies',s.owner,{invoiceIds:[transit.id],marketplace:'wb',destination:'Тестовый пункт в пути',shipDate:'2026-10-04',virtualWarehouseId:null});
 // Visual fixture: completed historical transport. No WB calls or shipping writes.
 await s.q("UPDATE invoices SET source='wb',external_id=number WHERE id=ANY($1::uuid[])",[[queued.id,assembly.id,transit.id]]);
 await s.q("UPDATE invoices SET status='shipped',shipped_at=now() WHERE id=$1",[transit.id]);await s.q("UPDATE supplies SET status='shipped',shipped_at=now() WHERE id=$1",[departed.id]);
 const ret=await app.ok('POST','/api/returns/manual',s.owner,{companyId:s.company,items:[{sku:'0000123',qty:2}]});
 const defect=await app.ok('POST','/api/defects/moves',s.worker,{companyId:s.company,sku:'UI-LONG',fromCellBlockId:s.cells[0].id,toCellBlockId:s.cells[3].id,qty:10,bucket:'defective',note:'Повреждение корпуса, проверочная запись',source:'move'});
 await app.ok('POST','/api/defects/moves',s.worker,{companyId:s.company,sku:'0000123',fromCellBlockId:s.cells[0].id,toCellBlockId:s.cells[4].id,qty:1,bucket:'packaging_defect',note:'Повреждена упаковка',source:'move'});
 await app.ok('POST','/api/vwarehouses/transfers',s.owner,{companyId:s.company,sku:'UI-LONG',qty:2,fromVw:a.id,toVw:b.id,note:'Проверочное уведомление о переносе'});
 await s.q("INSERT INTO product_marketplace_skus(warehouse_id,company_id,sku,marketplace,mp_sku,mp_barcode,mp_article) VALUES($1,$2,$3,'wb','999001','0000000000123','ТЕСТ-АРТИКУЛ')",[s.warehouseId,s.company,'UI-LONG']);
 // Cached synthetic marketplace facts only: this string cannot authenticate to WB.
 await s.q("INSERT INTO marketplace_credentials(warehouse_id,company_id,marketplace,encrypted_payload,wb_warehouses_at,wb_stocks_at) VALUES($1,$2,'wb','review-inert-not-a-credential',now(),now())",[s.warehouseId,s.company]);
 await s.q("INSERT INTO seller_wb_warehouses(warehouse_id,company_id,mp_warehouse_id,name,ours,office_city,office_address) VALUES($1,$2,'990001',$3,true,'Екатеринбург','Синтетический пункт 1'),($1,$2,'990002','Другой склад продавца',false,'Пермь','Синтетический пункт 2')",[s.warehouseId,s.company,'Склад визуальной рецензии — '+LONG]);
 await s.q("UPDATE products SET category=CASE WHEN sku='UI-LONG' THEN 'Упаковка' ELSE 'Аксессуары' END WHERE company_id=$1",[s.company]);
 const empty=await app.ok('POST','/api/sellers/companies',s.owner,{name:'Пустой продавец'});const ek=await app.ok('POST','/api/sellers/companies/'+empty.id+'/keys',s.owner,{});const emptyToken=(await app.ok('POST','/api/auth/seller/login',null,{keyCode:ek.key_code,name:'Пустой кабинет'})).token;
 return {...s,a,b,inbound,supply,departed,queued,assembly,transit,ret,defect,emptyToken,skus,LONG};
}
module.exports={seed,LONG};
