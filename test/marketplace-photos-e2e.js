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

    const warehouseId=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).warehouseId;
    const credentials=require('../src/marketplaces/credentials');
    const {syncPhotos}=require('../src/marketplaces/photos');
    const media='https://basket-01.wbbasket.ru/vol1/test.webp';
    for(const company of [a,b])await withTenantContext({warehouseId},async c=>{
      await credentials.save(c,warehouseId,{companyId:company.id,marketplace:'wb',token:'synthetic-content-key'});
      await c.query(`INSERT INTO products(warehouse_id,company_id,sku,name) VALUES($1,$2,'SAME','Same product')`,[warehouseId,company.id]);
      const nm=company.id===a.id?'123':'124';
      await c.query(`INSERT INTO product_marketplace_skus(warehouse_id,company_id,marketplace,sku,mp_sku) VALUES($1,$2,'wb','SAME',$3)`,[warehouseId,company.id,nm]);
      await syncPhotos(c,warehouseId,company.id,{fetchPage:async()=>({cards:[{nmID:nm,photos:[{big:company.id===a.id?media:media+'?company-b'}]}],cursor:{nmID:nm,updatedAt:'2026-09-10T01:00:00Z',total:1}})});
    });
    const ca=await api('GET','/api/sellers/catalog',sa),cb=await api('GET','/api/sellers/catalog',sb);
    assert.equal(ca.products[0].cards[0].photoUrl,media);assert.equal(cb.products[0].cards[0].photoUrl,media+'?company-b');
    assert.equal((await api('GET','/api/sellers/catalog?companyId='+b.id,sa)).products[0].cards[0].photoUrl,media);
    const hidden=await withTenantContext({companyId:a.id},c=>c.query('SELECT * FROM marketplace_product_media WHERE company_id=$1',[b.id]));assert.equal(hidden.rowCount,0);
    const secret=await withTenantContext({companyId:a.id},c=>c.query('SELECT id FROM marketplace_credentials'));assert.equal(secret.rowCount,0);
    await withTenantContext({warehouseId},c=>credentials.save(c,warehouseId,{companyId:a.id,marketplace:'wb',token:'synthetic-replacement-key'}));
    assert.equal((await api('GET','/api/sellers/catalog',sa)).products[0].cards[0].photoUrl,null);
    const reset=await withTenantContext({warehouseId},c=>c.query('SELECT photo_cursor,photo_sync_after FROM marketplace_credentials WHERE company_id=$1',[a.id]));assert.deepEqual(reset.rows[0].photo_cursor,{});assert.equal(reset.rows[0].photo_sync_after,null);
    console.log('PASS dedicated DB: photo sync/cache, seller RLS, forged company query, no credential access, key rotation clears old photos and restarts cursor');
  } finally { await new Promise(r=>server.close(r));await pool.end(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
