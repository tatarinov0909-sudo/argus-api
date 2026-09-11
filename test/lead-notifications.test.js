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
