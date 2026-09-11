// Explicit isolated database only. Never reads .env or reaches external APIs.
const assert = require('node:assert/strict');
const db = process.env.DATABASE_URL;
if (!db || !/test/i.test(new URL(db).pathname) || process.env.ARGUS_TEST_ALLOW_WRITES !== '1') {
  throw Error('Use an explicitly provisioned test database and ARGUS_TEST_ALLOW_WRITES=1');
}
const { createApp } = require('../src/app');
const { withTenantContext, pool } = require('../src/db/pool');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening',r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method,path,token,body,status=200) {
    const response = await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
    const data = await response.json();
    assert.equal(response.status,status,JSON.stringify(data));
    return data;
  }
  try {
    const stamp = Date.now();
    const reg=await api('POST','/api/auth/owner/register',null,{name:'History test',email:`history-${stamp}@example.invalid`,password:'history-test-password',warehouseName:'History test',city:'Test'},201);
    const owner=reg.token, warehouseId=JSON.parse(Buffer.from(owner.split('.')[1],'base64url')).warehouseId;
    const alpha=await api('POST','/api/sellers/companies',owner,{name:'History A'},201);
    const beta=await api('POST','/api/sellers/companies',owner,{name:'History B'},201);
    const key=await api('POST',`/api/sellers/companies/${alpha.id}/keys`,owner,undefined,201);
    const seller=(await api('POST','/api/auth/seller/login',null,{keyCode:key.key_code,name:'History viewer'})).token;
    const staff=await api('POST','/api/staff',owner,{name:'History test worker'},201);
    const worker=(await api('POST','/api/auth/staff/login',null,{keyCode:staff.key_code})).token;
    await api('POST','/api/cells/rows',owner,{configs:[{rackCount:2,tierCount:1},{rackCount:1,tierCount:1}]},201);
    const blocks=(await api('GET','/api/cells/rows',owner)).flatMap(r=>r.blocks);
    await withTenantContext({warehouseId},async c=>{
      await c.query('UPDATE cell_blocks SET label=$2 WHERE id=$1',[blocks[0].id,'HISTORY-A']);
      await c.query('UPDATE cell_blocks SET label=$2 WHERE id=$1',[blocks[2].id,'FOREIGN-HISTORY-B']);
    });
    async function invoice(companyId,number,direction,qty) {
      return api('POST','/api/invoices',owner,{companyId,number,direction,items:[{name:'History test item',sku:'SharedCase',declaredQty:qty}]},201);
    }
    await api('POST','/api/products',owner,{companyId:alpha.id,sku:'SharedCase',name:'History test item'},201);
    const incoming=await invoice(alpha.id,'HISTORY-IN','in',100);
    await api('POST','/api/receiving',worker,{invoiceItemId:incoming.items[0].id,acceptedQty:100,cellBlockId:blocks[0].id},201);
    const foreign=await invoice(beta.id,'FOREIGN-IN','in',12);
    await api('POST','/api/receiving',worker,{invoiceItemId:foreign.items[0].id,acceptedQty:12,cellBlockId:blocks[2].id},201);
    const standalone=await invoice(alpha.id,'HISTORY-OUT','out',3);
    await api('POST','/api/shipping',worker,{invoiceItemId:standalone.items[0].id,pickedQty:3,cellBlockId:blocks[0].id},201);
    await withTenantContext({warehouseId},c=>c.query("UPDATE shipping_records SET finished_at=now()-interval '1 hour' WHERE invoice_item_id=$1",[standalone.items[0].id]));
    const before=await api('GET','/api/sellers/history?sku=SharedCase',seller);
    assert.equal(before.events.filter(e=>e.kind==='shipped').length,0);
    await api('POST',`/api/shipping/${standalone.id}/ship`,owner);
    const after=await api('GET','/api/sellers/history?sku=SharedCase',seller);
    const shipped=after.events.find(e=>e.kind==='shipped');
    const picked=after.events.find(e=>e.kind==='picked');
    assert.ok(shipped && new Date(shipped.at)>new Date(picked.at),'departure is a later real event');
    assert.equal(shipped.qty,3);assert.equal(shipped.fromCell.label,'HISTORY-A');
    assert.equal(after.events.find(e=>e.kind==='received').toCell.label,'HISTORY-A');
    assert.ok(after.events.every(e=>e.document!=='FOREIGN-IN'));

    const second=await invoice(alpha.id,'HISTORY-SUPPLY-ORDER','out',4);
    const supply=await api('POST','/api/supplies',owner,{invoiceIds:[second.id]},201);
    await api('POST','/api/shipping',worker,{invoiceItemId:second.items[0].id,pickedQty:4,cellBlockId:blocks[0].id},201);
    await api('POST',`/api/supplies/${supply.id}/ready`,owner);
    const departed=await api('POST',`/api/supplies/${supply.id}/ship`,owner);
    const supplyHistory=await api('GET','/api/sellers/history?sku=SharedCase',seller);
    const event=supplyHistory.events.find(e=>e.kind==='shipped'&&e.document==='HISTORY-SUPPLY-ORDER');
    assert.equal(event.at,departed.shipped_at);assert.equal(event.supplyNumber,supply.number);
    // Historical supply timestamp is a saved fact even without invoice timestamp.
    await withTenantContext({warehouseId},c=>c.query('UPDATE invoices SET shipped_at=NULL WHERE id=$1',[second.id]));
    const historical=await api('GET','/api/sellers/history?sku=SharedCase',seller);
    assert.equal(historical.events.find(e=>e.kind==='shipped'&&e.document==='HISTORY-SUPPLY-ORDER').at,departed.shipped_at);

    await withTenantContext({warehouseId},c=>c.query(`
      INSERT INTO stock_operations(warehouse_id,company_id,sku,kind,qty,to_cell_block_id,created_at)
      SELECT $1,$2,'SharedCase','move',1,$3,'2025-01-01 00:00:00.123456+00'::timestamptz FROM generate_series(1,235)`,[warehouseId,alpha.id,blocks[0].id]));
    const first=await api('GET','/api/sellers/history?sku=SharedCase&limit=17',seller);
    assert.equal(first.events.length,17);assert.ok(first.nextCursor);
    await withTenantContext({warehouseId},c=>c.query(`INSERT INTO stock_operations(warehouse_id,company_id,sku,kind,qty,to_cell_block_id) VALUES ($1,$2,'SharedCase','move',1,$3)`,[warehouseId,alpha.id,blocks[0].id]));
    const all=[...first.events];let cursor=first.nextCursor,pages=1;
    while(cursor){const page=await api('GET','/api/sellers/history?sku=SharedCase&limit=17&cursor='+encodeURIComponent(cursor),seller);all.push(...page.events);cursor=page.nextCursor;assert.ok(++pages<50);}
    assert.equal(all.length,240); // 1 receipt, 2 picks, 2 departures, 235 operations.
    assert.equal(new Set(all.map(e=>e.eventKey)).size,all.length,'no duplicates across equal timestamps');
    assert.ok(all.every(e=>e.fromCell?.label!=='FOREIGN-HISTORY-B'&&e.toCell?.label!=='FOREIGN-HISTORY-B'));
    const scoped=await api('GET',`/api/sellers/history?sku=SharedCase&companyId=${beta.id}`,seller);
    assert.ok(scoped.events.every(e=>e.document!=='FOREIGN-IN'));
    await api('GET','/api/sellers/history?sku=other&cursor='+first.nextCursor,seller,undefined,400);
    await api('GET','/api/sellers/history?sku=SharedCase&limit=100000',seller,undefined,400);
    await withTenantContext({companyId:alpha.id},async c=>{
      const visible=(await c.query('SELECT id FROM cell_blocks')).rows;
      assert.ok(visible.some(b=>b.id===blocks[0].id));
      assert.ok(!visible.some(b=>b.id===blocks[2].id));
      const foreignRows=(await c.query('SELECT id FROM warehouse_rows WHERE id=$1',[blocks[2].warehouse_row_id])).rows;
      assert.equal(foreignRows.length,0);
    });
    await api('GET','/api/cells/rows',seller,undefined,403);
    const movements=await api('GET','/api/sellers/movements',seller);
    assert.equal(movements.shipped.find(e=>e.order==='HISTORY-OUT').at,shipped.at);
    console.log('PASS seller history: real departures, address RLS, 240 records, stable cursor, cross-seller isolation');
  } finally {
    await new Promise(r=>server.close(r));await pool.end();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
