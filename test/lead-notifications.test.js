const {test}=require('node:test');
const assert=require('node:assert/strict');
const {call,messageFor,retryDelay,TelegramError}=require('../src/leads/telegram');
test('Telegram failures never retain token, response or network URL',async()=>{
  const token='private-test-value';
  for(const fetcher of [async()=>{throw Error('https://api.telegram.org/bot'+token);},async()=>({ok:false,status:401,json:async()=>({ok:false,description:token,error_code:401})})]){
    await assert.rejects(call(token,'sendMessage',{},fetcher),e=>e instanceof TelegramError&&!e.stack.includes(token));
  }
});
test('retry honours Telegram backoff and caps exponential growth',()=>{
  assert.equal(retryDelay(1,300),300);assert.equal(retryDelay(50),21600);
});
test('lead message fits Telegram and retains plain applicant text',()=>{
  const message=messageFor({id:'test',name:'<b>name</b>',contact:'test@example.invalid',message:'a'.repeat(4000)});
  assert.ok(message.length<4096);assert.ok(message.includes('<b>name</b>'));
});
test('no arbitrary Telegram endpoints or redirect destinations',async()=>{
  await assert.rejects(call('test','deleteWebhook'),/method_forbidden/);
  await call('test','getMe',{},async(url,options)=>{
    assert.equal(url,'https://api.telegram.org/bottest/getMe');assert.equal(options.redirect,'error');
    return {ok:true,json:async()=>({ok:true,result:{is_bot:true}})};
  });
});
test('private relay receives only an allowed method and keeps the bot token out of its URL',async()=>{
  const beforeUrl=process.env.TELEGRAM_RELAY_URL,beforeToken=process.env.TELEGRAM_RELAY_TOKEN;
  process.env.TELEGRAM_RELAY_URL='http://10.77.0.2:8787';process.env.TELEGRAM_RELAY_TOKEN='relay-test-secret';
  try {
    await call('123456:'+ 'a'.repeat(32),'getMe',{},async(url,options)=>{
      assert.equal(String(url),'http://10.77.0.2:8787/telegram/getMe');
      assert.equal(options.headers.Authorization,'Bearer relay-test-secret');
      assert.deepEqual(JSON.parse(options.body),{token:'123456:'+ 'a'.repeat(32),body:{}});
      return {ok:true,json:async()=>({ok:true,result:{is_bot:true}})};
    });
  } finally {
    if (beforeUrl===undefined) delete process.env.TELEGRAM_RELAY_URL; else process.env.TELEGRAM_RELAY_URL=beforeUrl;
    if (beforeToken===undefined) delete process.env.TELEGRAM_RELAY_TOKEN; else process.env.TELEGRAM_RELAY_TOKEN=beforeToken;
  }
});
