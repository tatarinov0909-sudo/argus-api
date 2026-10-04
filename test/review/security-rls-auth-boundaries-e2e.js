// Дополнительная проверка границ: прямой argus_app, повторное использование
// пула, алгоритмы/истечение/продление JWT и параллельная смена пароля.
// Только синтетические данные и одноразовая БД через run-probe.cjs.
process.env.CORS_ORIGIN='https://review-ui.example.test';
const fs=require('node:fs'),jwt=require('jsonwebtoken');
const {startApp,stand,verdicts,fail,realFetch}=require('../attack-0310/_lib');
const {pool,withTenantContext,withoutTenantContext}=require('../../src/db/pool');
const {tenantContextFromAuth}=require('../../src/auth/tenantContext');
const suffix=new URL(process.env.DATABASE_URL).pathname.split('_').at(-1);
const decode=t=>jwt.decode(t);
const v=verdicts('Безопасность: прямой RLS и новые комбинации auth');
(async()=>{
 const app=await startApp(),evidence={tables:[],auth:[]};
 try{
  const a=await stand(app,{managerGrants:['staff']}),b=await stand(app);
  await a.receive([{qty:3,cell:a.cells[0]}]);await b.receive([{qty:7,cell:b.cells[0]}]);
  const otherCompany=(await app.ok('POST','/api/sellers/companies',a.owner,{name:'Другой продавец A'})).id;
  await app.ok('POST','/api/products',a.owner,{companyId:otherCompany,sku:'OTHER',name:'Только другой продавец A'});
  const role=(await withoutTenantContext(c=>c.query('SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))).rows[0];
  v.expect('Проверка идёт под argus_app без superuser/BYPASSRLS',role.name==='argus_app'&&!role.rolsuper&&!role.rolbypassrls,'argus_app false false',JSON.stringify(role));
  const tables=(await withoutTenantContext(c=>c.query(`SELECT c.relname AS name,c.relrowsecurity AS rls,pg_get_userbyid(c.relowner) AS owner,
    bool_or(a.attname='warehouse_id') AS wh,bool_or(a.attname='company_id') AS company
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
    WHERE n.nspname='public' AND c.relkind='r' GROUP BY c.oid,c.relname,c.relrowsecurity,c.relowner
    HAVING bool_or(a.attname IN ('warehouse_id','company_id')) ORDER BY c.relname`))).rows;
  for(const t of tables){
   if(!/^[a-z_][a-z0-9_]*$/.test(t.name))throw Error('Неожиданное имя таблицы');
   const visible=await withTenantContext({warehouseId:a.warehouseId},c=>c.query(`SELECT count(*)::int AS n FROM "${t.name}"`));
   const nobody=await withoutTenantContext(c=>c.query(`SELECT count(*)::int AS n FROM "${t.name}"`));
   const foreign=t.wh?(await withTenantContext({warehouseId:a.warehouseId},c=>c.query(`SELECT count(*)::int AS n FROM "${t.name}" WHERE warehouse_id<>$1`,[a.warehouseId]))).rows[0].n:0;
   const sellerForeign=t.company?(await withTenantContext({companyId:a.company},c=>c.query(`SELECT count(*)::int AS n FROM "${t.name}" WHERE company_id<>$1`,[a.company]))).rows[0].n:0;
   const row={...t,visibleA:visible.rows[0].n,noContext:nobody.rows[0].n,foreignWarehouse:foreign,foreignCompany:sellerForeign};evidence.tables.push(row);
   v.expect(`RLS ${t.name}: включён, роль не владелец, чужих строк нет`,t.rls&&t.owner!==role.name&&row.noContext===0&&foreign===0&&sellerForeign===0,'RLS; outside=0',JSON.stringify(row));
  }
  v.expect('Контекст продавца не содержит склад',JSON.stringify(tenantContextFromAuth(decode(a.seller)))===JSON.stringify({companyId:a.company}),'{companyId}',JSON.stringify(tenantContextFromAuth(decode(a.seller))));
  const sellerProducts=(await withTenantContext({companyId:a.company},c=>c.query('SELECT company_id FROM products'))).rows;
  v.expect('Свой товар виден, товар соседнего продавца скрыт',sellerProducts.length===1&&sellerProducts[0].company_id===a.company,'ровно свой товар','количество '+sellerProducts.length);
  const foreignUpdate=await withTenantContext({warehouseId:a.warehouseId},c=>c.query('UPDATE products SET name=$1 WHERE company_id=$2',['Не должно измениться',b.company]));
  v.expect('Прямой UPDATE чужого товара не затрагивает строки',foreignUpdate.rowCount===0,'0',foreignUpdate.rowCount);
  let insertCode;try{await withTenantContext({warehouseId:a.warehouseId},c=>c.query('INSERT INTO products(warehouse_id,company_id,sku,name) VALUES($1,$2,$3,$4)',[b.warehouseId,b.company,'BAD','Чужое']));}catch(e){insertCode=e.code;}
  v.expect('Прямой INSERT чужого tenant блокирует RLS',insertCode==='42501','42501',insertCode);
  await Promise.all(Array.from({length:12},(_,i)=>withTenantContext({warehouseId:i%2?a.warehouseId:b.warehouseId},async c=>{
   const target=i%2?a.warehouseId:b.warehouseId;
   const r=await c.query('SELECT id FROM warehouses');
   if(r.rows.length!==1||r.rows[0].id!==target)throw Error('Смешались контексты');
   if(i%3===0)throw Error('review deliberate rollback');
  }).catch(e=>{if(e.message!=='review deliberate rollback')throw e;})));
  const after=await Promise.all(Array.from({length:12},()=>withoutTenantContext(c=>c.query('SELECT id FROM warehouses'))));
  v.expect('После параллельных COMMIT/ROLLBACK tenant не остаётся в пуле',after.every(r=>r.rowCount===0),'12×0',after.map(r=>r.rowCount).join(','));
  for(const action of ['UPDATE','DELETE']){
   let code;try{await a.run(c=>c.query(action==='UPDATE'?'UPDATE journal_entries SET status=status':'DELETE FROM journal_entries'));}catch(e){code=e.code;}
   v.expect(`Журнал: прямой ${action} запрещён`,code==='42501','42501',code);
  }
  const raw=async(token,headers={})=>{const r=await realFetch(app.base+'/api/warehouses/me',{headers:{Authorization:'Bearer '+token,...headers}});await r.text();return {status:r.status,renewed:r.headers.get('x-argus-token'),cors:r.headers.get('access-control-allow-origin'),cache:r.headers.get('cache-control')};};
  const now=Math.floor(Date.now()/1000),{iat,exp,...claims}=decode(a.owner);
  const invalid=[['expired',jwt.sign({...claims,iat:now-100,exp:now-1},process.env.JWT_SECRET,{algorithm:'HS256'})],
   ['wrong-signature',jwt.sign({...claims,iat:now,exp:now+600},'different-local-test-secret',{algorithm:'HS256'})],
   ['HS512',jwt.sign({...claims,iat:now,exp:now+600},process.env.JWT_SECRET,{algorithm:'HS512'})],
   ['none',Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({...claims,exp:now+600})).toString('base64url')+'.']];
  for(const [name,t] of invalid){const r=await raw(t);evidence.auth.push({name,status:r.status,renewed:Boolean(r.renewed)});v.expect(`${name}:401 без продления`,r.status===401&&!r.renewed,'401/no renewal',r.status+'/'+Boolean(r.renewed));}
  const aged=jwt.sign({...claims,iat:now-7*3600,exp:now+5*3600},process.env.JWT_SECRET,{algorithm:'HS256'});
  const renewed=await raw(aged,{Origin:process.env.CORS_ORIGIN});
  v.expect('Продление сохраняет owner/warehouse и даёт свежий срок',renewed.status===200&&decode(renewed.renewed)?.role==='owner'&&decode(renewed.renewed)?.warehouseId===a.warehouseId&&decode(renewed.renewed)?.exp>now+11*3600,'owner,свой склад,>11ч','status '+renewed.status);
  v.expect('Настроенный CORS разрешает только заданный origin и no-store',renewed.cors===process.env.CORS_ORIGIN&&renewed.cache==='no-store','configured origin/no-store',renewed.cors+'/'+renewed.cache);
  const alien=await raw(a.owner,{Origin:'https://untrusted.example.test'});
  v.expect('Чужому origin не выдаётся CORS-разрешение',alien.cors===null,'null',alien.cors);
  const before=(await app.ok('GET','/api/staff',a.owner)).find(x=>x.kind==='manager');
  await app.ok('GET','/api/staff',a.manager);
  await app.ok('PATCH',`/api/staff/${before.id}/toggle`,a.owner,{});
  await new Promise(resolve=>setTimeout(resolve,2100));
  const managerClaims=decode(a.manager);delete managerClaims.iat;delete managerClaims.exp;
  const revokedOld=jwt.sign({...managerClaims,iat:now-7*3600,exp:now+5*3600},process.env.JWT_SECRET,{algorithm:'HS256'});
  const revoked=await raw(revokedOld);
  v.expect('Отозванный ключ после срока кеша не работает и не продлевается',revoked.status===401&&!revoked.renewed,'401/no renewal',revoked.status+'/'+Boolean(revoked.renewed));
  const changes=await Promise.all(['review-new-password-one','review-new-password-two'].map(newPassword=>app.api('POST','/api/auth/owner/password',a.owner,{currentPassword:'test-only-password',newPassword})));
  const statuses=changes.map(r=>r.status).sort();
  v.expect('Две параллельные смены пароля: один победитель',JSON.stringify(statuses)==='[200,409]','[200,409]',JSON.stringify(statuses));
  const old=await raw(a.owner),newer=await raw(changes.find(r=>r.status===200)?.body.token);
  v.expect('После гонки старый вход401, токен победителя200',old.status===401&&newer.status===200,'401/200',old.status+'/'+newer.status);
  fs.writeFileSync(`C:/Users/tatar/Desktop/argus-review/security-rls-auth-${suffix}.json`,JSON.stringify(evidence,null,2));
  console.log('RLS tables='+tables.length+'; populated under A='+evidence.tables.filter(t=>t.visibleA>0).length);
  v.done();
 }finally{await app.stop();}
})().catch(fail);
