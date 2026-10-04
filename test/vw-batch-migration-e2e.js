// Destructive migration roundtrip ONLY in an explicitly provisioned disposable DB.
const assert = require('node:assert/strict');
const path = require('node:path');
const {Client} = require('pg');
const migrate = require('node-pg-migrate').runner;
const appUrl = new URL(process.env.DATABASE_URL || 'postgres://invalid/');
const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL || 'postgres://invalid/');
if(!/^\/argus_seller_test_/.test(appUrl.pathname) || appUrl.pathname !== adminUrl.pathname
  || appUrl.hostname !== adminUrl.hostname || appUrl.port !== adminUrl.port) throw Error('Explicit matching disposable test databases required');
(async()=>{
  const admin = new Client({connectionString:adminUrl.href});await admin.connect();
  try{
    const latest = (await admin.query('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1')).rows[0]?.name;
    assert.ok(/^1754405100000_vw_transfer_batches/.test(latest),'Only the VW batch migration may be rolled back');
    const options = {databaseUrl:adminUrl.href,dir:path.join(__dirname,'../src/db/migrations'),
      migrationsTable:'pgmigrations',singleTransaction:false,log:()=>{},logger:{info(){},warn(){},error(){}}};
    await migrate({...options,direction:'down',count:1});
    assert.equal((await admin.query("SELECT to_regclass('vw_transfer_batches') AS table_name")).rows[0].table_name,null);
    await migrate({...options,direction:'up'});
    const app = new Client({connectionString:appUrl.href});await app.connect();
    try{
      const role = (await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
      const table = (await app.query(`SELECT relrowsecurity,pg_get_userbyid(relowner) AS owner,
        has_table_privilege(current_user,oid,'SELECT') AS readable,
        has_table_privilege(current_user,oid,'INSERT') AS insertable,
        has_table_privilege(current_user,oid,'UPDATE') AS mutable,
        has_table_privilege(current_user,oid,'DELETE') AS deletable
        FROM pg_class WHERE oid='vw_transfer_batches'::regclass`)).rows[0];
      assert.equal(table.relrowsecurity,true);assert.notEqual(table.owner,appUrl.username);
      for(const grant of ['readable','insertable','mutable','deletable'])assert.equal(table[grant],true);
      assert.equal((await app.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname IN
        ('idx_products_transfer_page','idx_vw_move_tasks_transfer_source')`)).rows[0].n,2);
      assert.equal((await app.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename='vw_transfer_batches'")).rows[0].n,1);
    }finally{await app.end();}
    console.log('PASS VW batch migration down/up; restricted-role grants, RLS and both indexes preserved');
  }finally{await admin.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
