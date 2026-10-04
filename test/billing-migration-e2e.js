// Одноразовая отдельная база с миграциями ДО personal-billing. Проверяем
// перенос настоящего сохранённого прайса без восстановления прошлых цен.
const assert=require('node:assert/strict');
const path=require('node:path');
const {Client}=require('pg');
const migrate=require('node-pg-migrate').runner;
const db=new URL(process.env.ADMIN_DATABASE_URL || 'postgres://invalid/').pathname;
if(!/^\/argus_seller_test_/.test(db) || process.env.ARGUS_TEST_ALLOW_WRITES!=='1') throw Error('Explicit isolated migration test database required');
(async()=>{
  const c=new Client({connectionString:process.env.ADMIN_DATABASE_URL}); await c.connect();
  try {
    assert.equal((await c.query("SELECT to_regclass('billing_company_tariffs') AS t")).rows[0].t,null,'Requires a fresh pre-personal-billing test database');
    const owner=(await c.query(`INSERT INTO owners(name,email,password_hash) VALUES ('Migration test','migration-only@example.test','test-only-unused-hash') RETURNING id`)).rows[0];
    const wh=(await c.query(`INSERT INTO warehouses(owner_id,name,city,warehouse_code,timezone)
      VALUES ($1,'Stored tariff test','Test','9001','Pacific/Kiritimati'),($1,'No tariff test','Test','9002','UTC') RETURNING id,timezone`,[owner.id])).rows;
    const a=(await c.query(`INSERT INTO companies(warehouse_id,name) VALUES ($1,'Seller A'),($1,'Seller B'),($2,'Seller C') RETURNING id,warehouse_id`,[wh[0].id,wh[1].id])).rows;
    const prices={storage:1.25,receiving:2,picking:3,returns:4};
    await c.query(`INSERT INTO billing_tariffs(warehouse_id,prices,storage_unit,show_sellers) VALUES ($1,$2,'cell_day',true)`,[wh[0].id,JSON.stringify(prices)]);
    const opts={databaseUrl:process.env.ADMIN_DATABASE_URL,dir:path.join(__dirname,'../src/db/migrations'),migrationsTable:'pgmigrations',direction:'up',singleTransaction:false,log:()=>{}};
    await migrate(opts);
    const rows=(await c.query(`SELECT company_id,prices,to_char(effective_from,'YYYY-MM-DD') AS day FROM billing_company_tariffs ORDER BY company_id`)).rows;
    assert.equal(rows.length,2); assert.ok(rows.every(r=>r.company_id!==a[2].id));
    assert.ok(rows.every(r=>JSON.stringify(r.prices)===JSON.stringify(prices) || Object.keys(prices).every(k=>r.prices[k]===prices[k])));
    const day=(await c.query("SELECT to_char(now() AT TIME ZONE 'Pacific/Kiritimati','YYYY-MM-DD') AS day")).rows[0].day;
    assert.ok(rows.every(r=>r.day===day));
    assert.equal((await c.query('SELECT count(*)::int AS n FROM billing_company_settings WHERE show_sellers AND NOT enabled')).rows[0].n,2);
    await c.query(`UPDATE billing_company_tariffs SET prices=jsonb_set(prices,'{storage}','99') WHERE company_id=$1`,[a[0].id]);
    assert.equal((await c.query('SELECT prices FROM billing_company_tariffs WHERE company_id=$1',[a[1].id])).rows[0].prices.storage,1.25);
    assert.equal((await c.query('SELECT prices FROM billing_tariffs WHERE warehouse_id=$1',[wh[0].id])).rows[0].prices.storage,1.25);
    console.log('PASS saved warehouse price copied into independent full prices only; starts on migration day in warehouse timezone; schedules remain off');
    await migrate({...opts,direction:'down',count:2});
    await migrate(opts);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM billing_company_tariffs')).rows[0].n,2);
    console.log('PASS personal billing and journal index migrations down/up on disposable database');
  } finally {await c.end();}
})().catch(e=>{console.error('FAIL',e.message);process.exitCode=1;});
