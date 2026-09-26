// Execute only with an explicitly named disposable database.
const assert = require('node:assert/strict');
const dbName = new URL(process.env.DATABASE_URL || 'postgres://invalid/').pathname;
if (!/^\/argus_seller_test_/.test(dbName) && !(dbName === '/argus_pilot_test_20260911' && process.env.ARGUS_TEST_ALLOW_WRITES === '1')) throw Error('Requires an explicitly provisioned isolated test database');
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
    await withTenantContext({warehouseId}, async c => {
      await c.query(
      `INSERT INTO products(warehouse_id,company_id,sku,name,barcode,stock_qty_1c,stock_at)
       VALUES($1,$2,'SAME-SKU','Synthetic product','0000123456789',0,now()),
             ($1,$2,'ONLY-1C','Not received yet',NULL,900,now()),
             ($1,$2,'AMBIGUOUS-BARCODE','Ambiguous barcode',NULL,1,now())`, [warehouseId,a.id]);
      await c.query(
        `INSERT INTO product_marketplace_skus
           (warehouse_id,company_id,sku,marketplace,mp_sku,mp_barcode)
         VALUES($1,$2,'ONLY-1C','wb','111111111','0000999000001'),
               ($1,$2,'AMBIGUOUS-BARCODE','wb','222222221','0000999000002'),
               ($1,$2,'AMBIGUOUS-BARCODE','wb','222222222','0000999000003')`,
        [warehouseId,a.id]);
      await c.query(
        `INSERT INTO products(warehouse_id,company_id,sku,name,active)
         VALUES($1,$2,'INACTIVE-PILOT-FIXTURE','Inactive fixture',false)`, [warehouseId,a.id]);
      const accepted = (await c.query(
        `INSERT INTO seller_inventory_snapshots
           (warehouse_id,company_id,source_kind,source_label,observed_at,accepted_at,status,item_count,total_qty,content_hash)
         VALUES($1,$2,'file','isolated-test.json',now(),now(),'accepted',3,1901,'test-hash') RETURNING id`,
        [warehouseId,a.id],
      )).rows[0];
      await c.query(
        `INSERT INTO seller_inventory_snapshot_items(snapshot_id,warehouse_id,company_id,sku,quantity)
         VALUES($1,$2,$3,'SAME-SKU',1000),($1,$2,$3,'ONLY-1C',900),($1,$2,$3,'AMBIGUOUS-BARCODE',1)`,
        [accepted.id,warehouseId,a.id],
      );
    });
    async function stock() { return (await api('GET','/api/sellers/stock?companyId='+a.id,token)).find(r=>r.sku==='SAME-SKU'); }
    let row = await stock();
    assert.equal(row.qtyIn1c,0); assert.equal(row.barcode,'0000123456789'); assert.equal(row.onHand,100);
    const sellerView = await api('GET','/api/sellers/stock',sa);
    const sellerSame = sellerView.rows.find(r=>r.sku==='SAME-SKU');
    // Договор с кабинетом продавца: четыре количества и сколько заказов за
    // каждым из обещанных чисел. Ничего про ячейки, 1С и сверку.
    assert.deepEqual(Object.keys(sellerSame).sort(), ['assemblyOrders','available','barcode','defective','inAssembly','inTransit','name','ordered','orderedOrders','sku','total','totalKnown','updatedAt'].sort());
    assert.equal(sellerSame.total,0); assert.equal(sellerSame.ordered,0); assert.equal(sellerSame.inAssembly,0);
    assert.equal(sellerSame.available,0); assert.equal(sellerSame.totalKnown,true);
    assert.equal(JSON.stringify(sellerSame).includes('cell'),false); assert.equal(JSON.stringify(sellerSame).includes('1c'),false);
    assert.equal(JSON.stringify(sellerView).includes('reserved'),false);
    assert.equal(sellerView.summary.productCount,3); assert.equal(sellerView.summary.total,901);
    assert.equal(sellerView.summary.inAssembly,0); assert.equal(sellerView.summary.ordered,0);
    assert.equal(sellerView.summary.available,901);
    await withTenantContext({warehouseId},c=>c.query(
      `UPDATE products SET stock_qty_1c=2,stock_at=now() WHERE company_id=$1 AND sku='SAME-SKU'`,[a.id]));
    assert.equal((await api('GET','/api/sellers/stock',sa)).rows.find(r=>r.sku==='SAME-SKU').total,2);
    await withTenantContext({warehouseId},c=>c.query(
      `UPDATE products SET stock_qty_1c=100,stock_at=now() WHERE company_id=$1 AND sku='SAME-SKU'`,[a.id]));
    const only1c = (await api('GET','/api/sellers/stock?companyId='+a.id,token)).find(r=>r.sku==='ONLY-1C');
    assert.equal(only1c.onHand,null); assert.equal(only1c.available,null); assert.equal(only1c.stockKnown,false); assert.equal(only1c.qtyIn1c,900);
    assert.equal(only1c.barcode,'0000999000001');
    const ambiguous = (await api('GET','/api/sellers/stock?companyId='+a.id,token)).find(r=>r.sku==='AMBIGUOUS-BARCODE');
    assert.equal(ambiguous.barcode,null);
    assert.equal((await api('GET','/api/sellers/stock',sa)).rows.some(r=>r.sku==='INACTIVE-PILOT-FIXTURE'),false);
    assert.equal((await api('GET','/api/sellers/catalog',sa)).products.some(r=>r.sku==='INACTIVE-PILOT-FIXTURE'),false);
    console.log('PASS latest 1C quantity replaces the older file snapshot; internal fields stay hidden');

    const order = await invoice(a,'out',30);
    const orders = await api('GET','/api/sellers/orders',sa);
    assert.equal(orders.rows.length,1); assert.equal(Number(orders.rows[0].qty),30);
    assert.equal(orders.rows[0].id,order.id); assert.equal(orders.hasMore,false);
    assert.equal((await api('GET','/api/sellers/orders',sb)).rows.length,0);
    assert.equal((await api('GET','/api/sellers/orders?companyId='+a.id,sb)).rows.length,0);
    assert.equal((await api('GET','/api/sellers/orders?companyId='+a.id,token)).rows.length,1);
    await api('GET','/api/sellers/orders',null,undefined,401);
    console.log('PASS seller orders and company isolation, including query override');
    await invoice(a,'out',2,'ORDER-ONLY');
    const stockWithUnresolved = await api('GET','/api/sellers/stock',sa);
    assert.equal(stockWithUnresolved.rows.some(r=>r.sku==='ORDER-ONLY'),false);
    assert.equal(stockWithUnresolved.summary.total,1001);
    assert.equal(stockWithUnresolved.summary.inAssembly,0);
    // Заказ на 30 штук уже куплен на площадке: он «заказан» и уменьшает
    // доступное, хотя склад его ещё не получал (решение владельца 17.09.2026).
    assert.equal(stockWithUnresolved.summary.ordered,30);
    assert.equal(stockWithUnresolved.summary.available,971);
    assert.equal(JSON.stringify(stockWithUnresolved).includes('reserved'),false);
    console.log('PASS unresolved orders do not create inventory or an invented seller reserve');
    row=await stock(); assert.equal(row.available,70); assert.equal(row.ordered,30);
    await api('POST','/api/shipping',worker,{invoiceItemId:order.items[0].id,pickedQty:10,cellBlockId:cells[0].id,isFinal:false},201);
    row=await stock(); assert.equal(row.qty,90); assert.equal(row.staged,10); assert.equal(row.onHand,100); assert.equal(row.available,70);
    let sellerDuringPick=await api('GET','/api/sellers/stock',sa);
    assert.equal(sellerDuringPick.summary.total,1001);
    // Начали отбирать — весь заказ перешёл из «заказано» в «в сборке»,
    // и доступное от этого не изменилось: обещание то же самое.
    assert.equal(sellerDuringPick.summary.inAssembly,30);
    assert.equal(sellerDuringPick.summary.ordered,0);
    assert.equal(sellerDuringPick.summary.available,971);
    await api('POST','/api/shipping',worker,{invoiceItemId:order.items[0].id,pickedQty:20,cellBlockId:cells[0].id,isFinal:true},201);
    row=await stock(); assert.equal(row.qty,70); assert.equal(row.staged,30); assert.equal(row.onHand,100); assert.equal(row.available,70);
    sellerDuringPick=await api('GET','/api/sellers/stock',sa);
    assert.equal(sellerDuringPick.summary.inAssembly,30);
    assert.equal(sellerDuringPick.summary.available,971);
    assert.equal((await api('GET','/api/sellers/movements',sa)).shipped.length,0);
    console.log('PASS new order, partial pick and ready order keep available=70; ready is not shipped');
    await api('POST',`/api/shipping/${order.id}/ship`,token,{});
    row=await stock(); assert.equal(row.onHand,70); assert.equal(row.staged,0); assert.equal(row.ordered,0); assert.equal(row.available,70);
    sellerDuringPick=await api('GET','/api/sellers/stock',sa);
    assert.equal(sellerDuringPick.summary.inAssembly,0);
    assert.equal(sellerDuringPick.summary.available,1001);
    assert.equal((await api('GET','/api/sellers/movements',sa)).shipped.length,2);
    console.log('PASS departure decreases on-hand and releases the order exactly once');

    const ret=await invoice(a,'return',5);
    await api('POST','/api/returns',worker,{invoiceItemId:ret.items[0].id,qty:5,qualityBucket:'defective',cellBlockId:cells[2].id,defectNote:'Test damaged box'},201);
    row=await stock(); assert.equal(row.onHand,70); assert.equal(row.notForSale,5); assert.equal(row.defective,5);
    const history=await api('GET','/api/sellers/history?sku=SAME-SKU',sa);
    assert.equal(history.events.filter(r=>r.kind==='received').length,1);
    assert.ok(history.events.some(r=>r.note==='Test damaged box'));
    const foreign=await api('GET',`/api/sellers/stock?companyId=${a.id}`,sb);
    assert.equal(foreign.rows.length,0);
    const foreignHistory=await api('GET',`/api/sellers/history?sku=SAME-SKU&companyId=${a.id}`,sb);
    assert.equal(foreignHistory.events.length,1); assert.equal(foreignHistory.events[0].qty,55);
    await api('GET',`/api/invoices/${order.id}`,sb,undefined,404);
    console.log('PASS defects remain unsellable; seller history and direct invoice IDs isolated for same SKU');
    await invoice(a,'out',90);
    row=await stock(); assert.equal(row.available,0); assert.equal(row.short,20);
    console.log('PASS shortages are explicit and availability does not go below zero');
    assert.equal((await api('GET','/api/sellers/profile?companyId='+a.id,sb)).id,b.id);
    const docs=await api('GET','/api/sellers/documents?companyId='+a.id,sb);
    assert.equal(docs.rows.length,1); assert.equal(docs.rows[0].direction,'in');
    assert.equal(Number(docs.rows[0].declared_qty),55);
    await api('GET','/api/sellers/export/1c?download=1',sa,undefined,403);
    const blocked=await api('GET','/api/sellers/export/1c?download=1&companyId='+a.id,token,undefined,422);
    assert.ok(blocked.issues.some(i=>i.sku==='AMBIGUOUS-BARCODE'&&i.code==='missing_barcode'));
    await withTenantContext({warehouseId},c=>c.query(
      `INSERT INTO products(warehouse_id,company_id,sku,name,barcode,stock_qty_1c,stock_at) VALUES($1,$2,'SAME-SKU','Synthetic B','0000000000555',55,now())`,[warehouseId,b.id]));
    const snapshot=await api('GET','/api/sellers/export/1c?download=1&companyId='+b.id,token);
    assert.equal(snapshot.seller.id,b.id); assert.equal(snapshot.items.length,1);
    assert.equal(snapshot.items[0].barcode,'0000000000555'); assert.equal(snapshot.items[0].available,55);
    const outB=await invoice(b,'out',55);
    await api('POST','/api/shipping',worker,{invoiceItemId:outB.items[0].id,pickedQty:55,cellBlockId:cells[1].id,isFinal:true},201);
    let emptyCell=(await api('GET','/api/sellers/stock?companyId='+b.id,token)).find(r=>r.sku==='SAME-SKU');
    assert.equal(emptyCell.onHand,55); assert.equal(emptyCell.stockKnown,true); assert.equal(emptyCell.available,0);
    await api('POST',`/api/shipping/${outB.id}/ship`,token,{});
    emptyCell=(await api('GET','/api/sellers/stock?companyId='+b.id,token)).find(r=>r.sku==='SAME-SKU');
    assert.equal(emptyCell.onHand,0); assert.equal(emptyCell.stockKnown,true); assert.equal(emptyCell.available,0);
    let sellerAfterArgusShip=await api('GET','/api/sellers/stock',sb);
    assert.equal(sellerAfterArgusShip.rows[0].total,55);
    assert.equal(sellerAfterArgusShip.rows[0].inAssembly,0);
    assert.equal(sellerAfterArgusShip.rows[0].available,55);
    await withTenantContext({warehouseId},c=>c.query(
      `UPDATE products SET stock_qty_1c=0,stock_at=now() WHERE company_id=$1 AND sku='SAME-SKU'`,[b.id]));
    sellerAfterArgusShip=await api('GET','/api/sellers/stock',sb);
    assert.equal(sellerAfterArgusShip.rows[0].total,0);
    assert.equal(sellerAfterArgusShip.rows[0].available,0);
    assert.equal((await api('GET','/api/sellers/export/1c?download=1&companyId='+b.id,token)).items[0].onHand,0);
    console.log('PASS shipment becomes final in seller quantities after the following 1C stock update');
    console.log('PASS profile, documents and export isolation; unknown blocked; leading zeros preserved; depleted stock stays known zero');
    await withTenantContext({warehouseId},c=>c.query(
      `INSERT INTO product_marketplace_skus(warehouse_id,company_id,sku,marketplace,mp_sku,mp_article)
       VALUES($1,$2,'SAME-SKU','wb','123456789','SELLER-A'),($1,$3,'SAME-SKU','wb','987654321','SELLER-B')`,[warehouseId,a.id,b.id]));
    const catalog=await api('GET','/api/sellers/catalog?companyId='+a.id,sb);
    assert.equal(catalog.products[0].cards[0].nmId,'987654321');
    assert.ok(!JSON.stringify(catalog).includes('123456789'));
    await withTenantContext({warehouseId},c=>c.query('UPDATE invoice_items SET mp_nm_id=$2,mp_article=$3 WHERE invoice_id=$1',[order.id,'123456789','SELLER-A']));
    const enriched=await api('GET','/api/sellers/orders',sa);
    assert.equal(enriched.rows.find(r=>r.id===order.id).mp_nm_id,'123456789');
    console.log('PASS real marketplace IDs; catalog company isolation');
  } finally {
    await new Promise(r=>server.close(r)); await pool.end();
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
