const assert=require('node:assert/strict');
const {Client}=require('pg');
if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.includes('test') || process.env.ARGUS_TEST_ALLOW_WRITES!=='1') throw Error('Explicit isolated test database required');
const {createApp}=require('../src/app');
const {pool,withoutTenantContext}=require('../src/db/pool');
const {withLeadAdmin}=require('../src/leads/access');
const {encrypt}=require('../src/marketplaces/crypto');
const {runOnce}=require('../src/leads/runner');
const {TelegramError}=require('../src/leads/telegram');
const telegram=require('../src/leads/telegram');
const admin=new Client({connectionString:process.env.ADMIN_DATABASE_URL});
let server,passed=0;
async function main(){
  await admin.connect();server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  async function api(path,method='GET',body,token){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
  const stamp=Date.now();
  const owner=await api('/api/auth/owner/register','POST',{name:'Test admin',email:`admin-${stamp}@example.invalid`,password:'isolated-test-password',warehouseName:'Test warehouse',city:'Test'});
  assert.equal(owner.status,201);
  const other=await api('/api/auth/owner/register','POST',{name:'Test other',email:`other-${stamp}@example.invalid`,password:'isolated-test-password',warehouseName:'Other test',city:'Test'});
  const t=owner.body.token, prefix='/api/leads/manage';
  assert.equal((await api(prefix+'/access','GET',undefined,t)).status,403);passed++;
  await admin.query('INSERT INTO platform_administrators(owner_id) VALUES($1)',[owner.body.owner.id]);
  await withLeadAdmin(owner.body.owner.id,c=>c.query('UPDATE lead_notification_settings SET token_ciphertext=null,chat_id=null,enabled_since=null,pending_hash=null WHERE id=true'));
  assert.equal((await api(prefix+'/access','GET',undefined,t)).status,200);passed++;
  assert.equal((await api(prefix,'GET')).status,401);assert.equal((await api(prefix,'GET',undefined,other.body.token)).status,403);passed++;
  const lead=await api('/api/leads','POST',{name:'Test applicant',contact:`lead-${stamp}@example.invalid`,message:'<script>not executable</script>'});assert.equal(lead.status,201);
  const listed=await api(prefix,'GET',undefined,t);assert.equal(listed.status,200);
  const row=listed.body.items.find(x=>x.contact===`lead-${stamp}@example.invalid`);assert.ok(row);passed++;
  assert.equal((await withoutTenantContext(c=>c.query('SELECT id FROM leads'))).rowCount,0);passed++;
  assert.equal((await api(prefix+'/'+row.id+'/status','PATCH',{status:'closed'},other.body.token)).status,403);
  assert.equal((await api(prefix+'/'+row.id+'/status','PATCH',{status:'contacted'},t)).status,200);passed++;
  const settings=await api(prefix+'/telegram','GET',undefined,t);assert.equal(settings.body.connected,false);assert.ok(!('token_ciphertext' in settings.body));passed++;
  const originalCall=telegram.call;
  let startText='';
  telegram.call=async(_token,method)=>method==='getMe'?{is_bot:true,username:'Argus_test_bot'}:method==='getWebhookInfo'?{url:''}:method==='getUpdates'?[{update_id:1,message:{text:startText,chat:{type:'group',id:-123},from:{is_bot:false}}}]:{message_id:111};
  const pairing=await api(prefix+'/telegram/connect','POST',{token:'123456:'+ 'a'.repeat(32)},t);
  assert.equal(pairing.status,200);startText='/start '+new URL(pairing.body.url).searchParams.get('start');
  assert.equal((await api(prefix+'/telegram/confirm','POST',{},t)).body.connected,false);passed++; // groups cannot hijack the recipient
  telegram.call=async(_token,method)=>method==='getUpdates'?[{update_id:2,message:{text:startText,chat:{type:'private',id:123},from:{is_bot:false}}}]:{message_id:112};
  assert.equal((await api(prefix+'/telegram/confirm','POST',{},other.body.token)).status,403);
  assert.equal((await api(prefix+'/telegram/confirm','POST',{},t)).body.connected,true);
  assert.equal((await api(prefix+'/telegram/confirm','POST',{},t)).status,409);passed++; // nonce consumed
  const linked=await api(prefix+'/telegram','GET',undefined,t);assert.equal(linked.body.connected,true);
  assert.ok(!JSON.stringify(linked.body).includes('aaaa'));assert.ok(!('chat_id'in linked.body));passed++;
  assert.equal((await api(prefix+'/telegram','DELETE',undefined,t)).status,200);
  telegram.call=originalCall;
  assert.equal((await api(prefix+'/'+row.id+'/notify','POST',{},t)).status,409);passed++;
  await withLeadAdmin(owner.body.owner.id,c=>c.query(`UPDATE lead_notification_settings SET token_ciphertext=$1,chat_id='test-chat',bot_username='test_bot',enabled_since=now() WHERE id=true`,[encrypt('test-not-real-token')]));
  let sends=0;
  await runOnce(async()=>{sends++;return {message_id:123};});assert.equal(sends,0);passed++; // old leads not silently sent
  assert.equal((await api(prefix+'/'+row.id+'/status','PATCH',{status:'closed'},t)).status,200);
  assert.equal((await api(prefix+'/'+row.id+'/notify','POST',{},t)).status,409);
  assert.equal((await api(prefix+'/'+row.id+'/status','PATCH',{status:'contacted'},t)).status,200);passed++;
  assert.equal((await api(prefix+'/'+row.id+'/notify','POST',{},t)).status,200);
  await runOnce(async()=>{sends++;throw new TelegramError('rate_limit',120);});
  const failed=(await admin.query('SELECT * FROM leads WHERE id=$1',[row.id])).rows[0];
  assert.equal(failed.notified_at,null);assert.equal(failed.notify_attempts,1);assert.equal(failed.notify_error,'rate_limit');assert.ok(failed.notify_next_at-Date.now()>100000);passed++;
  await withLeadAdmin(owner.body.owner.id,c=>c.query('UPDATE leads SET notify_next_at=now() WHERE id=$1',[row.id]));
  await runOnce(async(_token,method,body)=>{assert.equal(method,'sendMessage');assert.equal(body.chat_id,'test-chat');assert.ok(!body.parse_mode);sends++;return {message_id:456};});
  assert.ok((await admin.query('SELECT notified_at FROM leads WHERE id=$1',[row.id])).rows[0].notified_at);passed++;
  const before=sends;await runOnce(async()=>{sends++;return {message_id:789};});assert.equal(sends,before);passed++;
  await withLeadAdmin(owner.body.owner.id,c=>c.query('UPDATE lead_notification_settings SET token_ciphertext=null,chat_id=null,enabled_since=null WHERE id=true'));
  await admin.query('UPDATE platform_administrators SET active=false WHERE owner_id=$1',[owner.body.owner.id]);
  assert.equal((await api(prefix,'GET',undefined,t)).status,403);passed++;
  console.log(`${passed} passed lead-management checks`);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await pool.end();await admin.end();});
