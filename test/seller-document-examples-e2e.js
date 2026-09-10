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
    const inv=await api('POST','/api/invoices',token,{companyId:b.id,number:'SOURCE-1C',direction:'in',items:[{name:'Product',sku:'SOURCE',declaredQty:100}]},201);
    await withTenantContext({warehouseId},c=>c.query("UPDATE invoices SET source='1c',external_id='test-example-source' WHERE id=$1",[inv.id]));
    const before=await api('GET','/api/sellers/stock',sa);
    await api('POST','/api/sellers/document-examples',sa,{companyId:a.id,invoiceId:inv.id},403);
    const example=await api('POST','/api/sellers/document-examples',token,{companyId:a.id,invoiceId:inv.id},201);
    const again=await api('POST','/api/sellers/document-examples',token,{companyId:a.id,invoiceId:inv.id},201);assert.equal(again.id,example.id);
    const list=await api('GET','/api/sellers/document-examples',sa);assert.equal(list.rows.length,1);assert.equal(list.rows[0].preview,true);assert.equal(list.rows[0].declared_qty,100);
    const detail=await api('GET','/api/sellers/document-examples/'+example.id,sa);assert.equal(detail.number,'SOURCE-1C');assert.equal(detail.items[0].declared_qty,'100');assert.equal(detail.items[0].accepted_qty,null);
    await api('GET','/api/sellers/document-examples/'+example.id,sb,null,404);
    assert.equal((await api('GET','/api/sellers/document-examples?companyId='+a.id,sb)).rows.length,0);
    await api('GET','/api/invoices/'+inv.id,sa,null,404);
    assert.deepEqual(await api('GET','/api/sellers/stock',sa),before);assert.equal((await api('GET','/api/sellers/documents',sa)).rows.length,0);
    const other=await api('POST','/api/auth/owner/register',null,{name:'Other',email:`example-other-${Date.now()}@example.test`,password:'test-only-password',warehouseName:'Other warehouse',city:'Test'},201);
    await api('POST','/api/sellers/document-examples',other.token,{companyId:a.id,invoiceId:inv.id},404);
    await api('DELETE','/api/sellers/document-examples/'+example.id,other.token,null,404);
    await api('DELETE','/api/sellers/document-examples/'+example.id,sa,null,403);
    await api('DELETE','/api/sellers/document-examples/'+example.id,token);
    await api('GET','/api/sellers/document-examples/'+example.id,sa,null,404);
    console.log('PASS examples: real source snapshot, owner-only publish/revoke, tenant and seller isolation, no source access, no stock changes, no fake receipts, idempotent publication');
  }finally{await new Promise(r=>server.close(r));await pool.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
