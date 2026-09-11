// Synthetic fixtures only, in an explicitly selected isolated test database.
// No dotenv, no WB network and no 1C calls. Run after all migrations.
const assert = require('node:assert/strict');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !/test/i.test(new URL(dbUrl).pathname)) {
  throw new Error('Select a separate test DATABASE_URL; live .env is forbidden');
}
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');
const { reconcile } = require('../src/marketplaces/statuses');
const { loadStock } = require('../src/sellers/stock');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let count=0;
  const check=(name,fn)=>{fn();count++;console.log('PASS '+name);};
  const api=async(method,path,token,body)=>{
    const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
    return {status:res.status,body:await res.json()};
  };
  const must=async(method,path,token,body,status=200)=>{
    const r=await api(method,path,token,body);assert.equal(r.status,status,JSON.stringify(r.body));return r.body;
  };
  try {
    const stamp=Date.now();
    const owner=await must('POST','/api/auth/owner/register',null,{name:'WB test owner',email:`wb-status-${stamp}@test.local`,password:'synthetic-pass-123',warehouseName:'WB reconciliation test',city:'Test'},201);
    const auth=JSON.parse(Buffer.from(owner.token.split('.')[1],'base64url'));
    const warehouseId=auth.warehouseId;
    const run=fn=>withTenantContext({warehouseId},fn);
    const company=await must('POST','/api/sellers/companies',owner.token,{name:'Test company A'},201);
    const foreignCompany=await must('POST','/api/sellers/companies',owner.token,{name:'Test company B'},201);
    const staff=await must('POST','/api/staff',owner.token,{name:'Test worker'},201);
    const worker=await must('POST','/api/auth/staff/login',null,{keyCode:staff.key_code});
    await must('POST','/api/cells/rows',owner.token,{configs:[{rackCount:2,tierCount:1}]},201);
    const cells=(await must('GET','/api/cells/rows',owner.token)).flatMap(r=>r.blocks);
    const cell=cells[0].id;
    for(const c of [company,foreignCompany]) {
      await run(q=>q.query(`INSERT INTO products(warehouse_id,company_id,sku,name) VALUES($1,$2,'TEST-SKU','Test stock')`,[warehouseId,c.id]));
      const inv=await must('POST','/api/invoices',owner.token,{companyId:c.id,number:`RECEIPT-${c.id}`,items:[{sku:'TEST-SKU',name:'Test stock',declaredQty:20}]},201);
      await must('POST','/api/receiving',worker.token,{invoiceItemId:inv.items[0].id,acceptedQty:20,cellBlockId:cell},201);
    }
    const orders=[];
    async function order(externalId,qty=2,picked=0,companyId=company.id){
      const inv=await must('POST','/api/invoices',owner.token,{companyId,number:'WB-'+externalId,direction:'out',items:[{sku:'TEST-SKU',name:'Test stock',declaredQty:qty}]},201);
      await run(q=>q.query(`UPDATE invoices SET source='wb',external_id=$2 WHERE id=$1`,[inv.id,String(externalId)]));
      await run(q=>q.query(`UPDATE invoice_items SET mp_rid=$2 WHERE invoice_id=$1`,[inv.id,'test-rid-'+externalId]));
      if(picked) await must('POST','/api/shipping',worker.token,{invoiceItemId:inv.items[0].id,pickedQty:picked,cellBlockId:cell,isFinal:picked===qty},201);
      orders.push(inv);return inv;
    }
    const untouched=await order(90101);
    const picked=await order(90102,2,2);
    const fulfilled=await order(90103,2,2);
    const noPicks=await order(90104);
    const partial=await order(90105,2,1);
    const unknown=await order(90106);
    const missing=await order(90107);
    const duplicate=await order(90108);
    const foreign=await order(90201,2,0,foreignCompany.id);
    const inSupply=await order(90109);
    const supply=await must('POST','/api/supplies',owner.token,{invoiceIds:[inSupply.id]},201);
    const physical=()=>run(q=>q.query(`SELECT company_id,sum(qty)::numeric AS qty FROM cell_stock WHERE warehouse_id=$1 GROUP BY company_id ORDER BY company_id`,[warehouseId]));
    const before=await physical();
    const response=[
      {id:90101,supplierStatus:'cancel',wbStatus:'canceled'},
      {id:90102,supplierStatus:'cancel',wbStatus:'canceled'},
      {id:90103,supplierStatus:'complete',wbStatus:'sorted'},
      {id:90104,supplierStatus:'complete',wbStatus:'sorted'},
      {id:90105,supplierStatus:'complete',wbStatus:'sorted'},
      {id:90106,supplierStatus:'future_status',wbStatus:'future_status'},
      {id:90108,supplierStatus:'cancel',wbStatus:'canceled'},
      {id:90108,supplierStatus:'new',wbStatus:'waiting'},
      {id:90109,supplierStatus:'cancel',wbStatus:'canceled'},
      {id:90201,supplierStatus:'cancel',wbStatus:'canceled'},
    ];
    const result=await run(q=>reconcile(q,warehouseId,company.id,'synthetic-token',{fetchStatuses:async()=>response}));
    check('explicit statuses close six; missing, unknown, duplicate and foreign IDs do not',()=>{
      assert.equal(result.closed,6);assert.equal(result.missing,2);assert.equal(result.conflicts,5);
    });
    const afterSync=await physical();
    check('sync never changes physical cell stock',()=>assert.deepEqual(afterSync.rows,before.rows));
    const unchanged=await run(q=>q.query(`SELECT id,status,mp_closed_at FROM invoices WHERE id=ANY($1::uuid[])`,[[unknown.id,missing.id,duplicate.id,foreign.id]]));
    check('unknown and other company orders stay untouched',()=>assert.ok(unchanged.rows.every(r=>!r.mp_closed_at&&r.status==='open')));
    const stock=await run(q=>loadStock(q,company.id));
    check('untouched cancellation releases demand but picked and delivered orders remain reserved',()=>{
      assert.equal(stock[0].onHand,20);assert.equal(stock[0].ordered,14);
    });
    const jobs=await must('GET','/api/invoices?direction=out',worker.token);
    check('closed WB orders are absent from worker task queue',()=>assert.ok(!jobs.some(r=>[untouched.id,picked.id,fulfilled.id].includes(r.id))));
    const cannotPick=await api('POST','/api/shipping',worker.token,{invoiceItemId:untouched.items[0].id,pickedQty:1,cellBlockId:cell});
    check('server rejects picking a cancelled order even from stale UI',()=>assert.equal(cannotPick.status,409));
    const cannotShip=await api('POST',`/api/shipping/${picked.id}/ship`,worker.token,{});
    check('server rejects ordinary shipping of a closed order',()=>assert.equal(cannotShip.status,409));
    const issues=await must('GET','/api/marketplaces/reconciliation',owner.token);
    check('all physical/supply/unrecorded-departure conflicts are visible',()=>assert.equal(issues.rows.length,5));
    const preview=await must('GET',`/api/marketplaces/reconciliation/${picked.id}`,owner.token);
    check('return preview shows exact recorded quantity and original cell',()=>{
      assert.equal(preview.action,'return_to_cells');assert.equal(preview.lines[0].qty,2);assert.equal(preview.lines[0].cellBlockId,cell);
    });
    const refusal=await api('POST',`/api/marketplaces/reconciliation/${picked.id}`,owner.token,{action:preview.action,version:preview.version,confirmed:false});
    check('explicit physical confirmation is mandatory',()=>assert.equal(refusal.status,400));
    const stale=await api('POST',`/api/marketplaces/reconciliation/${picked.id}`,owner.token,{action:preview.action,version:'old-preview',confirmed:true});
    check('stale preview cannot return stock',()=>assert.equal(stale.status,409));
    const resolved=await Promise.all([1,2].map(()=>api('POST',`/api/marketplaces/reconciliation/${picked.id}`,owner.token,{action:preview.action,version:preview.version,confirmed:true})));
    check('concurrent double confirmation returns stock only once',()=>{
      assert.ok(resolved.every(r=>r.status===200));assert.equal(resolved.filter(r=>r.body.repeated).length,1);
    });
    const returned=await physical();
    check('return changes only the target seller physical stock by recorded quantity',()=>{
      assert.equal(Number(returned.rows.find(r=>r.company_id===company.id).qty),17);
      assert.equal(Number(returned.rows.find(r=>r.company_id===foreignCompany.id).qty),20);
    });
    const stockAfter=await run(q=>loadStock(q,company.id));
    check('return does not inflate on-hand while releasing canceled reservation',()=>{
      assert.equal(stockAfter[0].onHand,20);assert.equal(stockAfter[0].ordered,12);
    });
    const trace=await run(q=>q.query(`SELECT kind,qty,to_cell_block_id,details FROM stock_operations WHERE company_id=$1 AND kind='canceled_pick_return'`,[company.id]));
    check('returned picks leave exactly one immutable stock operation',()=>{
      assert.equal(trace.rows.length,1);assert.equal(Number(trace.rows[0].qty),2);assert.equal(trace.rows[0].details.invoiceId,picked.id);
    });
    const fulfillPreview=await must('GET',`/api/marketplaces/reconciliation/${fulfilled.id}`,owner.token);
    const departedAt=new Date().toISOString();
    await must('POST',`/api/marketplaces/reconciliation/${fulfilled.id}`,owner.token,{action:fulfillPreview.action,version:fulfillPreview.version,confirmed:true,departedAt});
    const afterDeparture=await physical();
    check('confirming already-picked departure never deducts physical cell stock twice',()=>assert.deepEqual(afterDeparture.rows,returned.rows));
    const shipment=await run(q=>q.query(`SELECT status,shipped_at FROM invoices WHERE id=$1`,[fulfilled.id]));
    check('owner departure confirmation records real local shipment timestamp',()=>{
      assert.equal(shipment.rows[0].status,'shipped');assert.ok(shipment.rows[0].shipped_at);
      assert.equal(new Date(shipment.rows[0].shipped_at).toISOString(),departedAt);
    });
    for(const inv of [noPicks,partial]) {
      const p=await must('GET',`/api/marketplaces/reconciliation/${inv.id}`,owner.token);
      assert.equal(p.canResolve,false);assert.match(p.blocked,/полный отбор/);
    }
    check('WB delivery with absent/partial local picking is conservatively blocked',()=>{});
    const supplyPreview=await must('GET',`/api/marketplaces/reconciliation/${inSupply.id}`,owner.token);
    check('untouched canceled supply order previews detachment only',()=>assert.equal(supplyPreview.action,'remove_from_supply'));
    await must('POST',`/api/marketplaces/reconciliation/${inSupply.id}`,owner.token,{action:supplyPreview.action,version:supplyPreview.version,confirmed:true});
    const s=await run(q=>q.query(`SELECT supply_id FROM invoices WHERE id=$1`,[inSupply.id]));
    check('canceled order leaves local supply without any stock movement',()=>assert.equal(s.rows[0].supply_id,null));
    const forbidden=await api('GET','/api/marketplaces/reconciliation',worker.token);
    check('workers cannot perform owner reconciliation',()=>assert.equal(forbidden.status,403));
    const sellerKey=await must('POST',`/api/sellers/companies/${foreignCompany.id}/keys`,owner.token,{},201);
    const seller=await must('POST','/api/auth/seller/login',null,{keyCode:sellerKey.key_code,name:'Test seller'});
    const sellerDenied=await api('GET',`/api/marketplaces/reconciliation/${picked.id}`,seller.token);
    check('seller cannot inspect another seller reconciliation',()=>assert.equal(sellerDenied.status,403));
    const otherOwner=await must('POST','/api/auth/owner/register',null,{name:'Other owner',email:`wb-other-${stamp}@test.local`,password:'synthetic-pass-123',warehouseName:'Other test warehouse',city:'Test'},201);
    const tenantDenied=await api('GET',`/api/marketplaces/reconciliation/${picked.id}`,otherOwner.token);
    check('owner from another warehouse cannot access reconciliation',()=>assert.equal(tenantDenied.status,404));
    const mappingBody={marketplace:'wb',sku:'TEST-SKU',mpSku:'999001',mpArticle:'SAME-ARTICLE',mpBarcode:'SAME-BARCODE'};
    await must('POST','/api/marketplaces/mapping',owner.token,{...mappingBody,companyId:company.id},201);
    await must('POST','/api/marketplaces/mapping',owner.token,{...mappingBody,companyId:foreignCompany.id},201);
    const mapRows=await run(q=>q.query(`SELECT company_id,sku FROM product_marketplace_skus
      WHERE warehouse_id=$1 AND mp_article='SAME-ARTICLE' ORDER BY company_id`,[warehouseId]));
    check('identical marketplace keys coexist for different sellers without deleting either mapping',()=>{
      assert.equal(mapRows.rows.length,2);assert.deepEqual(new Set(mapRows.rows.map(r=>r.company_id)),new Set([company.id,foreignCompany.id]));
    });
    const barcodeBody={companyId:company.id,marketplace:'wb',sku:'TEST-SKU'};
    await must('POST','/api/marketplaces/mapping',owner.token,{...barcodeBody,mpBarcode:'BARCODE-ONE'},201);
    await must('POST','/api/marketplaces/mapping',owner.token,{...barcodeBody,mpBarcode:'BARCODE-TWO'},201);
    const bcRows=await run(q=>q.query(`SELECT mp_barcode FROM product_marketplace_skus WHERE company_id=$1 AND mp_sku IS NULL AND mp_article IS NULL`,[company.id]));
    check('barcode-only mapping supports multiple independent products',()=>assert.equal(bcRows.rows.length,2));
    const oldPartialPreview=await must('GET',`/api/marketplaces/reconciliation/${partial.id}`,owner.token);
    const beforeLateCancel=await physical();
    const reservedBeforeLateCancel=(await run(q=>loadStock(q,company.id)))[0].ordered;
    await run(q=>q.query(`UPDATE invoices SET mp_status_attempted_at=NULL WHERE id=ANY($1::uuid[])`,[[partial.id,noPicks.id,fulfilled.id,picked.id]]));
    await run(q=>reconcile(q,warehouseId,company.id,'synthetic-token',{fetchStatuses:async(_,ids)=>{
      assert.ok(ids.includes('90105')&&ids.includes('90104'));
      assert.ok(!ids.includes('90103')&&!ids.includes('90102'));
      return [90105,90104,90103,90102].map(id=>({id,supplierStatus:'cancel',wbStatus:'canceled'}));
    }}));
    const afterLateCancel=await physical();
    const newPartialPreview=await must('GET',`/api/marketplaces/reconciliation/${partial.id}`,owner.token);
    check('unresolved delivery remains polled and later cancellation changes required action without moving stock',()=>{
      assert.deepEqual(afterLateCancel.rows,beforeLateCancel.rows);
      assert.equal(newPartialPreview.reason,'canceled');assert.equal(newPartialPreview.action,'return_to_cells');
      assert.equal(newPartialPreview.canResolve,true);assert.equal(newPartialPreview.lines[0].qty,1);
      assert.notEqual(newPartialPreview.version,oldPartialPreview.version);
    });
    const staleDelivery=await api('POST',`/api/marketplaces/reconciliation/${partial.id}`,owner.token,
      {action:oldPartialPreview.action,version:oldPartialPreview.version,confirmed:true,departedAt:new Date().toISOString()});
    const reservedAfterLateCancel=(await run(q=>loadStock(q,company.id)))[0].ordered;
    check('changed WB status invalidates old departure preview and only untouched cancellation releases demand',()=>{
      assert.equal(staleDelivery.status,409);assert.equal(reservedAfterLateCancel,reservedBeforeLateCancel-2);
    });
    const alreadyResolved=await run(q=>q.query(`SELECT id,status,mp_close_reason,mp_stock_returned_at FROM invoices WHERE id=ANY($1::uuid[])`,[[fulfilled.id,picked.id]]));
    check('late provider responses never undo confirmed departure or confirmed return',()=>{
      assert.equal(alreadyResolved.rows.find(r=>r.id===fulfilled.id).status,'shipped');
      assert.equal(alreadyResolved.rows.find(r=>r.id===fulfilled.id).mp_close_reason,'fulfilled');
      assert.ok(alreadyResolved.rows.find(r=>r.id===picked.id).mp_stock_returned_at);
    });
    console.log(`\n${count} marketplace reconciliation checks passed`);
  } finally {
    await new Promise(r=>server.close(r));await pool.end();
  }
})().catch(err=>{console.error(err);process.exitCode=1;});
