// Actual HTTP + argus_app/RLS, synthetic fixtures in a dedicated test DB only.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const {startApp,stand}=require('./attack-0310/_lib');
const batch=require('../src/vwarehouses/batch');
const service=require('../src/vwarehouses/service');
let checks=0;
const check=(label,fn)=>{fn();checks++;console.log('ok '+label);};
async function admin(sql,params=[]){
  const url=process.env.TEST_DATABASE_ADMIN_URL;
  if(!url||new URL(url).pathname!==new URL(process.env.DATABASE_URL).pathname)throw Error('Admin must point to the same dedicated test DB');
  const c=new Client({connectionString:url});await c.connect();try{return(await c.query(sql,params)).rows;}finally{await c.end();}
}
(async()=>{
  const app=await startApp();
  try{
    const skus=[['A','Товар A'],['B','Товар B'],['C','Товар C'],['D','Товар D'],['E','Товар E'],['Z-FAIL','Ошибка'],['P%_','Буквальный знак'],['HIDDEN','Неактивный']];
    const s=await stand(app,{skus,managerGrants:['warehouse']});
    const target=await app.ok('POST','/api/vwarehouses',s.owner,{companyId:s.company,name:'Целевой',marketplace:'other'});
    const separated=await app.ok('POST','/api/vwarehouses',s.owner,{companyId:s.company,name:'Отдельный',marketplace:'other',keepSeparate:true});
    await s.q(`UPDATE products SET barcode=CASE sku WHEN 'A' THEN '000123' WHEN 'B' THEN 'duplicate' WHEN 'C' THEN 'duplicate' END,
      active=(sku<>'HIDDEN') WHERE company_id=$1`,[s.company]);
    for(const [i,[sku,name]] of skus.filter(([sku])=>sku!=='HIDDEN').entries()){
      const r=await s.receive([{sku,name,qty:10,cell:s.cells[i% s.cells.length]}],{sku,name});
      assert.equal(r.results[0].status,201);
    }
    const data=(items,extra={})=>({companyId:s.company,toVw:target.id,requestId:randomUUID(),items:items.map(i=>({fromVw:null,...i})),...extra});
    const get=(extra='')=>'/api/vwarehouses/transfer-candidates?'+new URLSearchParams({companyId:s.company,toVw:target.id})+extra;
    const preview=(items)=>app.ok('POST','/api/vwarehouses/transfers/preview',s.owner,{companyId:s.company,toVw:target.id,items:items.map(r=>({fromVw:null,...r}))});
    const noGrant=await app.ok('POST','/api/staff',s.owner,{name:'Без складского права',kind:'manager',permissions:['billing']});
    const limited=(await app.ok('POST','/api/auth/staff/login',null,{keyCode:noGrant.key_code})).token;
    for(const token of [limited,s.worker,s.seller]){
      for(const [method,path,body] of [['GET',get(),undefined],['POST','/api/vwarehouses/transfers/preview',data([{sku:'A',qty:1}])],['POST','/api/vwarehouses/transfers/batch',data([{sku:'A',qty:1}])]]){
        const r=await app.api(method,path,token,body);check('role/grant rejects '+method+' '+path.split('?')[0],()=>assert.equal(r.status,403));
      }
    }
    const first=await app.ok('GET',get('&limit=2'),s.manager);
    const second=await app.ok('GET',get('&limit=2&cursor='+encodeURIComponent(first.nextCursor)),s.owner);
    check('bounded deterministic pages exclude inactive SKU',()=>{assert.equal(first.items.length,2);assert.equal(second.items.length,2);assert.equal(new Set([...first.items,...second.items].map(i=>i.sku)).size,4);});
    const changedCursor=await app.api('GET',get('&q=A&cursor='+encodeURIComponent(first.nextCursor)),s.owner);
    check('cursor scope cannot change',()=>assert.equal(changedCursor.status,400));
    const literal=await app.ok('GET',get('&q='+encodeURIComponent('%_')),s.owner);
    check('search escapes SQL wildcard characters',()=>assert.deepEqual(literal.items.map(i=>i.sku),['P%_']));
    const resolved=await preview([{barcode:'000123',qty:'2'}]);
    check('barcode keeps leading zeros and resolves exact catalogue SKU',()=>{assert.equal(resolved.canCommit,true);assert.equal(resolved.items[0].sku,'A');assert.equal(resolved.items[0].row,1);assert.equal(resolved.items[0].free,10);assert.equal(resolved.items[0].inDestination,0);});
    for(const [items,code] of [
      [[{barcode:'duplicate',qty:1}],'ambiguous_barcode'],[[{sku:'A',barcode:'duplicate',qty:1}],'identifier_mismatch'],
      [[{sku:'unknown',barcode:'000123',qty:1}],'unknown_sku'],[[{sku:'HIDDEN',qty:1}],'unknown_sku'],
      [[{sku:'A',qty:1},{barcode:'000123',qty:1}],'duplicate_sku'],[[{sku:'A',qty:true}],'invalid_qty'],
      [[{sku:'A',qty:1.2}],'invalid_qty'],[[{sku:'A',qty:Number.MAX_SAFE_INTEGER+1}],'invalid_qty'],
    ]){const p=await preview(items);check('preview '+code,()=>{assert.equal(p.canCommit,false);assert(p.errors.some(e=>e.code===code));});}
    // Fixed number of catalogue/quantity queries, independent of selected SKU count.
    let n=0;const all=await s.run(c=>batch.candidates({query:(...args)=>{n++;return c.query(...args);}},s.warehouseId,{companyId:s.company,toVw:target.id,limit:'200'}));
    // Пятый — «выключено ли адресное хранение» (06.10.2026): один на страницу, от числа SKU не зависит.
    check('one page uses five SQL queries for all SKUs',()=>{assert.equal(n,5);assert.equal(all.items.length,7);});
    const tooMany=await app.api('POST','/api/vwarehouses/transfers/batch',s.owner,data(Array.from({length:201},(_,i)=>({sku:'X'+i,qty:1}))));
    check('batch limit before writes',()=>{assert.equal(tooMany.status,400);assert.equal(tooMany.body.maxItems,200);});
    const dupe=await app.api('POST','/api/vwarehouses/transfers/batch',s.owner,data([{sku:'A',qty:1},{sku:'A',qty:2}]));
    check('duplicate canonical SKU rejected',()=>assert.equal(dupe.body.code,'duplicate_sku'));
    // A real DB trigger fails after first item executed; all effects must roll back.
    await admin(`CREATE FUNCTION vw_batch_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.sku='Z-FAIL' THEN RAISE EXCEPTION 'synthetic late batch failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER vw_batch_test_fail BEFORE INSERT ON vw_transfers FOR EACH ROW EXECUTE FUNCTION vw_batch_test_fail();`);
    const before=await s.q(`SELECT (SELECT count(*) FROM vw_transfers) AS transfers,(SELECT count(*) FROM journal_entries) AS journal,
      (SELECT count(*) FROM seller_notifications) AS notifications,(SELECT count(*) FROM vw_transfer_batches) AS batches`);
    const failed=await app.api('POST','/api/vwarehouses/transfers/batch',s.owner,data([{sku:'A',qty:2},{sku:'Z-FAIL',qty:2}]));
    const after=await s.q(`SELECT (SELECT count(*) FROM vw_transfers) AS transfers,(SELECT count(*) FROM journal_entries) AS journal,
      (SELECT count(*) FROM seller_notifications) AS notifications,(SELECT count(*) FROM vw_transfer_batches) AS batches`);
    check('late SQL failure rolls back stock, transfers, journal, notifications and nonce',()=>{assert.equal(failed.status,500);assert.deepEqual(after,before);});
    assert.equal((await s.vwQty('good','A'))['Остальной товар'],10);
    await admin('DROP TRIGGER vw_batch_test_fail ON vw_transfers; DROP FUNCTION vw_batch_test_fail();');
    const body=data([{sku:'B',qty:2},{sku:'A',qty:3}]);
    const done=await app.ok('POST','/api/vwarehouses/transfers/batch',s.manager,body,201);
    const retry=await app.ok('POST','/api/vwarehouses/transfers/batch',s.owner,{...body,items:[...body.items].reverse()},200);
    check('retry/reordered rows returns same transfer IDs and changes stock once',()=>{assert.equal(retry.replayed,true);assert.deepEqual(retry.items.map(i=>i.id),done.items.map(i=>i.id));assert(done.items.every(i=>i.status==='done'));});
    assert.equal((await s.vwQty('good','A'))['Целевой'],3);
    const changed=await app.api('POST','/api/vwarehouses/transfers/batch',s.owner,{...body,items:[{sku:'A',qty:4,fromVw:null},{sku:'B',qty:2,fromVw:null}]});
    check('same nonce with changed payload conflicts',()=>{assert.equal(changed.status,409);assert.equal(changed.body.code,'request_changed');});
    const simultaneous=data([{sku:'C',qty:2}]);
    const race=await Promise.all([1,2].map(()=>app.api('POST','/api/vwarehouses/transfers/batch',s.owner,simultaneous)));
    check('simultaneous retry creates one transaction',()=>{assert.deepEqual(race.map(r=>r.status).sort(),[200,201]);assert.equal(race[0].body.items[0].id,race[1].body.items[0].id);});
    const orderRace=await Promise.all([
      data([{sku:'D',qty:2},{sku:'E',qty:2}]),data([{sku:'E',qty:2},{sku:'D',qty:2}])
    ].map(b=>app.api('POST','/api/vwarehouses/transfers/batch',s.owner,b)));
    check('opposite SKU order concurrent batches avoid deadlock',()=>assert(orderRace.every(r=>r.status===201)));
    // Named source is exact; destination quantity excludes outstanding task promises.
    const exact='/api/vwarehouses/transfer-candidates?'+new URLSearchParams({companyId:s.company,toVw:separated.id,fromVw:target.id,q:'A'});
    const source=await app.ok('GET',exact,s.owner);
    check('named source free reflects only that source',()=>assert.equal(source.items.find(i=>i.sku==='A').free,3));
    await app.ok('PATCH','/api/vwarehouses/rights',s.seller,{rights:{decide:false}});
    const pending=await app.ok('POST','/api/vwarehouses/transfers/batch',s.owner,data([{sku:'A',qty:1}]),201);
    check('disabled seller right gives waiting_seller without physical movement',()=>assert.equal(pending.items[0].status,'waiting_seller'));
    assert.equal((await s.vwQty('good','A'))['Целевой'],3);
    await app.ok('PATCH','/api/vwarehouses/rights',s.seller,{rights:{decide:true}});
    const move=await app.ok('POST','/api/vwarehouses/transfers/batch',s.owner,data([{sku:'A',qty:2}],{toVw:separated.id}),201);
    check('keepSeparate produces to_move and one physical task',()=>assert.equal(move.items[0].status,'to_move'));
    // 1C reported total is deliberately irrelevant to actual cell availability.
    await s.q("UPDATE warehouses SET stock_source='1c' WHERE id=$1",[s.warehouseId]);
    await s.q("UPDATE products SET stock_qty_1c=100 WHERE company_id=$1 AND sku='A'",[s.company]);
    const out=await app.ok('POST','/api/invoices',s.owner,{companyId:s.company,number:'СБОРКА',direction:'out',items:[{sku:'A',name:'Товар A',declaredQty:3}]});
    await s.q("UPDATE invoices SET source='1c' WHERE id=$1",[out.id]);
    const amount=(await app.ok('GET',get('&q=A'),s.owner)).items.find(i=>i.sku==='A');
    check('free subtracts outstanding picking and move task promises',()=>{assert.equal(amount.inCells,7);assert.equal(amount.toPick,3);assert.equal(amount.promised,2);assert.equal(amount.free,2);assert.equal(amount.inDestination,3);});
    const over=await app.api('POST','/api/vwarehouses/transfers/batch',s.owner,data([{sku:'A',qty:3},{sku:'B',qty:1}]));
    check('one excessive item rejects whole batch with original row error',()=>{assert.equal(over.status,409);assert.equal(over.body.errors[0].row,1);assert.equal(over.body.errors[0].free,2);});
    await s.q(`INSERT INTO shipping_records(invoice_item_id,warehouse_id,company_id,picked_qty,is_final)
      VALUES($1,$2,$3,1,false)`,[out.items[0].id,s.warehouseId,s.company]);
    await s.q("UPDATE cell_stock SET qty=qty-1 WHERE company_id=$1 AND sku='A' AND virtual_warehouse_id IS NULL AND quality='good'",[s.company]);
    const partial=(await app.ok('GET',get('&q=A'),s.owner)).items.find(i=>i.sku==='A');
    check('partial picking reduces physical and remaining picking without double deduction',()=>{assert.equal(partial.inCells,6);assert.equal(partial.toPick,2);assert.equal(partial.free,2);});
    await s.q('UPDATE shipping_records SET is_final=true WHERE invoice_item_id=$1',[out.items[0].id]);
    const final=(await app.ok('GET',get('&q=A'),s.owner)).items.find(i=>i.sku==='A');
    check('final picking line no longer reserves unpicked shortage',()=>{assert.equal(final.toPick,0);assert.equal(final.free,4);});
    const task=(await app.ok('GET','/api/vwarehouses/move-tasks',s.worker)).find(t=>t.transfer===move.items[0].number);
    assert(task);
    await app.ok('POST','/api/vwarehouses/move-tasks/'+task.id+'/step',s.worker,{toCellBlockId:s.cells[7].id,qty:2});
    const moved=await app.ok('GET','/api/vwarehouses/transfer-candidates?'+new URLSearchParams({companyId:s.company,toVw:separated.id,q:'A'}),s.owner);
    check('worker step replaces promises with actual destination stock',()=>{const a=moved.items.find(i=>i.sku==='A');assert.equal(a.inCells,4);assert.equal(a.promised,0);assert.equal(a.free,4);assert.equal(a.inDestination,2);});
    const other=await stand(app,{skus:[['A','Другой товар']],managerGrants:['warehouse']});
    const otherVW=await app.ok('POST','/api/vwarehouses',other.owner,{companyId:other.company,name:'Чужой',marketplace:'other'});
    await other.q("UPDATE products SET barcode='000123' WHERE company_id=$1",[other.company]);
    const scopedBarcode=await preview([{barcode:'000123',qty:1}]);
    check('barcode lookup isolated even when another tenant has identical keys',()=>{assert.equal(scopedBarcode.canCommit,true);assert.equal(scopedBarcode.items[0].name,'Товар A');});
    for(const wrong of [{companyId:other.company,toVw:otherVW.id},{companyId:s.company,toVw:otherVW.id}]){
      const r=await app.api('POST','/api/vwarehouses/transfers/preview',s.owner,{...wrong,items:[{sku:'A',qty:1,fromVw:null}]});
      check('foreign company/warehouse scope rejected',()=>assert.equal(r.status,404));
    }
    const foreignCommit=await app.api('POST','/api/vwarehouses/transfers/batch',s.owner,{...data([{sku:'A',qty:1}]),companyId:other.company,toVw:otherVW.id});
    check('foreign company batch cannot be persisted',()=>assert([400,404].includes(foreignCommit.status)));
    const pool=require('../src/db/pool').pool;
    const unscoped=await pool.query('SELECT count(*) AS n FROM vw_transfer_batches');
    check('argus_app with no RLS context sees zero nonce records',()=>assert.equal(unscoped.rows[0].n,'0'));
    const tenantRows=await other.q('SELECT count(*) AS n FROM vw_transfer_batches');
    check('other tenant cannot see batch snapshots',()=>assert.equal(tenantRows[0].n,'0'));
    // Exact physical per-source calculation remains consistent with the original path.
    const compare=await s.run(async c=>({one:await service.transferable(c,s.company,'A',null),many:(await batch.availability(c,s.warehouseId,s.company,[{sku:'A',fromVw:null}])).get(JSON.stringify(['A',null]))}));
    check('bulk free agrees with existing single transfer rule',()=>assert.deepEqual(compare.many,compare.one));
    const compete=await Promise.all([1,2].map(()=>app.api('POST','/api/vwarehouses/transfers/batch',s.owner,data([{sku:'B',qty:5}]))));
    check('competing batches cannot spend the same available stock',()=>assert.deepEqual(compete.map(r=>r.status).sort(),[201,409]));
    assert.equal((await s.vwQty('good','B'))['Остальной товар'],3);
    await s.q(`INSERT INTO products(warehouse_id,company_id,sku,name)
      SELECT $1,$2,'MAX-'||lpad(n::text,3,'0'),'Пакетный товар '||n FROM generate_series(1,200) n`,[s.warehouseId,s.company]);
    await s.q(`INSERT INTO cell_stock(warehouse_id,company_id,sku,cell_block_id,qty)
      SELECT $1,$2,'MAX-'||lpad(n::text,3,'0'),$3,1 FROM generate_series(1,200) n`,[s.warehouseId,s.company,s.cells[0].id]);
    const full=data(Array.from({length:200},(_,i)=>({sku:'MAX-'+String(i+1).padStart(3,'0'),qty:1})));
    const began=Date.now(),fullResult=await app.api('POST','/api/vwarehouses/transfers/batch',s.owner,full);
    check('maximum 200 item batch completes with every canonical SKU once',()=>{assert.equal(fullResult.status,201);assert.equal(fullResult.body.items.length,200);assert.equal(new Set(fullResult.body.items.map(r=>r.id)).size,200);});
    console.log('200 item local transaction: '+(Date.now()-began)+' ms');
    console.log('Passed '+checks+' batch/availability checks');
  }catch(e){console.error(e.stack);process.exitCode=1;}finally{await app.stop();}
})();
