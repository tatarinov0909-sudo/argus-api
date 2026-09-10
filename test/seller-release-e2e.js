// Execute only with an explicitly named disposable database.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName)) throw Error('Requires a dedicated argus_seller_test_* database');
const { createApp } = require('../src/app');
const { pool, withTenantContext } = require('../src/db/pool');

(async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, path, token, body, status = 200) {
    const response = await fetch(base + path, { method, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${response.status} ${data.error || ''}`);
    return data;
  }
  try {
    const role = (await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    const owner = await api('POST', '/api/auth/owner/register', null, {
      name:'Test owner', email:`seller-release-${Date.now()}@example.test`, password:'test-only-password',
      warehouseName:'Isolated seller release', city:'Test',
    }, 201);
    const token = owner.token;
    const a = await api('POST', '/api/sellers/companies', token, {name:'Test A'}, 201);
    const b = await api('POST', '/api/sellers/companies', token, {name:'Test B'}, 201);
    async function seller(company) {
      const key = await api('POST', `/api/sellers/companies/${company.id}/keys`, token, {}, 201);
      return (await api('POST', '/api/auth/seller/login', null, {keyCode:key.key_code, name:'Test seller'})).token;
    }
    const sa = await seller(a), sb = await seller(b);
    const workerKey = await api('POST', '/api/staff', token, {name:'Test worker'}, 201);
    const worker = (await api('POST', '/api/auth/staff/login', null, {keyCode:workerKey.key_code})).token;
    await api('POST', '/api/cells/rows', token, {configs:[{rackCount:3,tierCount:2}]}, 201);
    const cells = (await api('GET', '/api/cells/rows', token)).flatMap(r => r.blocks);
    async function invoice(company, direction, qty, sku='SAME-SKU') {
      return api('POST', '/api/invoices', token, {companyId:company.id, number:`TEST-${direction}-${Date.now()}-${company.id}`, direction,
        items:[{name:'Synthetic product', sku, declaredQty:qty}]}, 201);
    }
    for (const [company, qty, cell] of [[a,100,cells[0]],[b,55,cells[1]]]) {
      const inv = await invoice(company,'in',qty);
      await api('POST', '/api/receiving', worker, {invoiceItemId:inv.items[0].id,acceptedQty:qty,cellBlockId:cell.id},201);
    }
    const warehouseId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).warehouseId;
    await withTenantContext({warehouseId}, c => c.query(
      `INSERT INTO products(warehouse_id,company_id,sku,name,barcode,stock_qty_1c,stock_at)
       VALUES($1,$2,'SAME-SKU','Synthetic product','0000123456789',0,now()),
             ($1,$2,'ONLY-1C','Not received yet',NULL,900,now())`, [warehouseId,a.id]));
    async function stock() { return (await api('GET','/api/sellers/stock',sa)).find(r=>r.sku==='SAME-SKU'); }
    let row = await stock();
    assert.equal(row.qtyIn1c,0); assert.equal(row.barcode,'0000123456789'); assert.equal(row.onHand,100);
    const only1c = (await api('GET','/api/sellers/stock',sa)).find(r=>r.sku==='ONLY-1C');
    assert.equal(only1c.onHand,0); assert.equal(only1c.qtyIn1c,900);
    console.log('PASS zero 1C balance and barcode preserved; 1C never overrides Argus stock');

    const order = await invoice(a,'out',30);
    const orders = await api('GET','/api/sellers/orders',sa);
    assert.equal(orders.rows.length,1); assert.equal(Number(orders.rows[0].qty),30);
    assert.equal(orders.rows[0].id,order.id); assert.equal(orders.hasMore,false);
    assert.equal((await api('GET','/api/sellers/orders',sb)).rows.length,0);
    assert.equal((await api('GET','/api/sellers/orders?companyId='+a.id,sb)).rows.length,0);
    assert.equal((await api('GET','/api/sellers/orders?companyId='+a.id,token)).rows.length,1);
    await api('GET','/api/sellers/orders',null,undefined,401);
    console.log('PASS seller orders and company isolation, including query override');
    row=await stock(); assert.equal(row.available,70); assert.equal(row.ordered,30);
    await api('POST','/api/shipping',worker,{invoiceItemId:order.items[0].id,pickedQty:10,cellBlockId:cells[0].id,isFinal:false},201);
    row=await stock(); assert.equal(row.qty,90); assert.equal(row.staged,10); assert.equal(row.onHand,100); assert.equal(row.available,70);
    await api('POST','/api/shipping',worker,{invoiceItemId:order.items[0].id,pickedQty:20,cellBlockId:cells[0].id,isFinal:true},201);
    row=await stock(); assert.equal(row.qty,70); assert.equal(row.staged,30); assert.equal(row.onHand,100); assert.equal(row.available,70);
    assert.equal((await api('GET','/api/sellers/movements',sa)).shipped.length,0);
    console.log('PASS new order, partial pick and ready order keep available=70; ready is not shipped');
    await api('POST',`/api/shipping/${order.id}/ship`,token,{});
    row=await stock(); assert.equal(row.onHand,70); assert.equal(row.staged,0); assert.equal(row.ordered,0); assert.equal(row.available,70);
    assert.equal((await api('GET','/api/sellers/movements',sa)).shipped.length,2);
    console.log('PASS departure decreases on-hand and releases the order exactly once');

    const ret=await invoice(a,'return',5);
    await api('POST','/api/returns',worker,{invoiceItemId:ret.items[0].id,qty:5,qualityBucket:'defective',cellBlockId:cells[2].id,defectNote:'Test damaged box'},201);
    row=await stock(); assert.equal(row.onHand,70); assert.equal(row.notForSale,5); assert.equal(row.defective,5);
    const history=await api('GET','/api/sellers/history?sku=SAME-SKU',sa);
    assert.equal(history.events.filter(r=>r.kind==='received').length,1);
    assert.ok(history.events.some(r=>r.note==='Test damaged box'));
    const foreign=await api('GET',`/api/sellers/stock?companyId=${a.id}`,sb);
    assert.equal(foreign.length,1); assert.equal(foreign[0].onHand,55);
    const foreignHistory=await api('GET',`/api/sellers/history?sku=SAME-SKU&companyId=${a.id}`,sb);
    assert.equal(foreignHistory.events.length,1); assert.equal(foreignHistory.events[0].qty,55);
    await api('GET',`/api/invoices/${order.id}`,sb,undefined,404);
    console.log('PASS defects remain unsellable; seller history and direct invoice IDs isolated for same SKU');
    await invoice(a,'out',90);
    row=await stock(); assert.equal(row.available,0); assert.equal(row.short,20);
    console.log('PASS shortages are explicit and availability does not go below zero');
  } finally {
    await new Promise(r=>server.close(r)); await pool.end();
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
