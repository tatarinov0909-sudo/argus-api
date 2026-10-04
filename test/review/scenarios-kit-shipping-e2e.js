// Дополнительная связка: состав из двух товаров -> готовые наборы -> бумажный
// отбор -> отгрузка. Только новая одноразовая БД через review/run-probe.cjs.
const assert=require('node:assert/strict');
const {startApp,stand,fail}=require('../attack-0310/_lib');
(async()=>{const a=await startApp();try{
 const s=await stand(a,{skus:[['A','Первый компонент'],['B','Второй компонент'],['KIT','Набор из двух товаров']]});
 await s.q('INSERT INTO product_kits (warehouse_id,company_id,kit_sku,component_sku,qty) VALUES ($1,$2,$3,$4,$5),($1,$2,$3,$6,$7)',[s.warehouseId,s.company,'KIT','A',2,'B',1]);
 await s.receive([{sku:'A',qty:10,cell:s.cells[0]},{sku:'B',qty:10,cell:s.cells[1]}]);
 const assembled=await a.ok('POST','/api/kits/assemble',s.worker,{companyId:s.company,kitSku:'KIT',qty:2,toCellBlockId:s.cells[2].id});
 assert.equal(assembled.qty,2);
 const before=await s.q('SELECT sku,sum(qty)::int qty FROM cell_stock WHERE warehouse_id=$1 GROUP BY sku',[s.warehouseId]);
 assert.deepEqual(Object.fromEntries(before.map(r=>[r.sku,r.qty])),{A:6,B:8,KIT:2});
 console.log('PASS сборка двух наборов списала ровно 4 A и 2 B');
 const inv=await a.ok('POST','/api/invoices',s.owner,{companyId:s.company,number:'WB-KIT',direction:'out',items:[{sku:'KIT',name:'Набор из двух товаров',declaredQty:2}]});
 await s.q("UPDATE invoices SET source='wb',external_id='990000001',mp_supplier_status='new' WHERE id=$1",[inv.id]);
 await s.q("UPDATE invoice_items SET mp_rid='review-kit-rid' WHERE invoice_id=$1",[inv.id]);
 const supply=await a.ok('POST','/api/supplies',s.manager,{invoiceIds:[inv.id],marketplace:'wb'});
 const pick=await a.ok('GET','/api/shipping/pick-list?supplyId='+supply.id,s.worker);
 assert.equal(pick.lines.find(l=>l.sku==='KIT').shortfall,0);
 await a.ok('POST','/api/shipping/paper/start',s.worker,{supplyId:supply.id});
 const finished=await a.ok('POST','/api/shipping/paper/finish',s.worker,{supplyId:supply.id,notFound:[]});
 const out=await a.ok('GET','/api/supplies/'+supply.id,s.manager);
 console.log('Бумажный лист:',JSON.stringify({status:out.supply?.status,report:finished.report||finished}));
 assert.equal(out.supply?.status,'ready','готовые наборы по бумажному листу должны быть отобраны');
 await a.ok('POST',`/api/supplies/${supply.id}/ship`,s.manager,{});
 const stock=await a.ok('GET','/api/sellers/stock',s.seller);
 const kit=stock.rows.find(r=>r.sku==='KIT');
 console.log('Набор после отгрузки:',JSON.stringify(kit));
 console.log('PASS наборы: состав, лист и отгрузка');
}catch(e){fail(e);}finally{await a.stop();}})();
