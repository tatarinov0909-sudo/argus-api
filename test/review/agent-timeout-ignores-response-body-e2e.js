// Настоящий fetch на loopback: ответчик сразу присылает заголовки,
// затем задерживает JSON дольше штатных 20 секунд. Нет ключа/вызова ИИ.
const http=require('node:http');
const {ask}=require('../../src/agents/orchestratorDeepseek');
const originalFetch=global.fetch;
(async()=>{
 let timer;
 const server=http.createServer((req,res)=>{
  req.resume();res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();
  timer=setTimeout(()=>res.end(JSON.stringify({choices:[{message:{content:'Локальный синтетический ответ'}}]})),22500);
 });
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 let outcome,elapsed;
 try{
  global.fetch=(url,opts)=>{
   if(url!=='https://api.deepseek.com/chat/completions')throw Error('Неожиданная сеть');
   return originalFetch(`http://127.0.0.1:${server.address().port}/fixture`,{...opts,headers:{'Content-Type':'application/json'}});
  };
  const started=Date.now();
  try{await ask('',null,'local-only','Локальная проверка тайм-аута',async()=>({}));outcome='success';}
  catch(e){outcome=e.status||e.statusCode||e.name;}
  elapsed=Date.now()-started;
  console.log(`Заголовки сразу, тело через22500мс; итог=${outcome}; длительность=${elapsed}мс`);
  console.log('Ожидание: 504 примерно через штатные20000мс, включая чтение тела');
  process.exitCode=outcome===504?0:1;
 }finally{global.fetch=originalFetch;clearTimeout(timer);server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(()=>{console.log('Сбой локального теста тайм-аута');process.exitCode=2;});
