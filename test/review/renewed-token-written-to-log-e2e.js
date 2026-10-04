// Только одноразовая локальная БД. Сырые логи дочернего процесса остаются
// в памяти родителя: найденные JWT/ключи никогда не выводятся и не сохраняются.
const cp=require('node:child_process'), crypto=require('node:crypto');
if(!process.argv.includes('--child')){
  const r=cp.spawnSync(process.execPath,[__filename,'--child'],{env:{...process.env,LOG_LEVEL:'info'},encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
  if(r.status!==0){console.log('ОШИБКА дочерней проверки, exit='+r.status+'; сырые логи не раскрываются');process.exitCode=2;}
  else {
    const rows=r.stdout.split(/\r?\n/).filter(Boolean).map(x=>{try{return JSON.parse(x);}catch{return null;}}).filter(Boolean);
    const proof=rows.find(x=>x.reviewProof)?.reviewProof;
    const log=rows.find(x=>x.req?.url==='/api/warehouses/me' && x.res?.headers?.['x-argus-token']);
    const token=log?.res?.headers?.['x-argus-token'];
    const hash=token && crypto.createHash('sha256').update(token).digest('hex');
    const leak=Boolean(proof?.renewed && proof?.accepted===200 && hash===proof?.hash);
    console.log('Продление X-Argus-Token: '+Boolean(proof?.renewed));
    console.log('Новый токен принят реальным API: '+proof?.accepted);
    console.log('Authorization в логе запроса: '+(log?.req?.headers?.authorization==='[скрыто]'?'замаскирован':'нет подтверждения'));
    console.log('Полный действующий токен записан как res.headers.x-argus-token: '+leak);
    console.log('Значения токенов и сырые логи не сохранены');
    process.exitCode=proof? (leak?1:0):2;
  }
} else {
  const jwt=require('jsonwebtoken');
  const {startApp,realFetch}=require('../attack-0310/_lib');
  (async()=>{
    const app=await startApp();
    try{
      const {token}=await app.ok('POST','/api/auth/owner/register',null,{name:'Локальная проверка',email:`review-log-${Date.now()}@example.test`,password:'test-only-password',warehouseName:'Проверка журналирования',city:'Тест'});
      const {iat,exp,...claims}=jwt.decode(token),now=Math.floor(Date.now()/1000);
      const aged=jwt.sign({...claims,iat:now-7*3600,exp:now+5*3600},process.env.JWT_SECRET,{algorithm:'HS256'});
      const response=await realFetch(app.base+'/api/warehouses/me',{headers:{Authorization:'Bearer '+aged}});
      await response.text();
      const fresh=response.headers.get('x-argus-token');
      const accepted=fresh?(await app.api('GET','/api/warehouses/me',fresh)).status:0;
      console.log(JSON.stringify({reviewProof:{renewed:Boolean(fresh),accepted,hash:fresh?crypto.createHash('sha256').update(fresh).digest('hex'):null}}));
    }finally{await app.stop();}
  })().catch(()=>{console.log(JSON.stringify({reviewError:true}));process.exitCode=2;});
}
