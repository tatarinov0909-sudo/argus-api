const { test } = require('node:test');
const assert = require('node:assert/strict');
const { photoUrl, syncPhotos } = require('../src/marketplaces/photos');
const credentials = require('../src/marketplaces/credentials');

test('catalog request only calls the documented read endpoint and preserves pagination', async t => {
  const original=global.fetch;t.after(()=>global.fetch=original);
  let request;
  global.fetch=async(url,options)=>{request={url,options};return {ok:true,text:async()=>JSON.stringify({cards:[],cursor:{total:0}})};};
  await require('../src/marketplaces/wb').productCards('synthetic-only',{updatedAt:'previous',nmID:123});
  assert.equal(request.url,'https://content-api.wildberries.ru/content/v2/get/cards/list');
  assert.equal(request.options.method,'POST');
  const settings=JSON.parse(request.options.body).settings;
  assert.deepEqual(settings.cursor,{updatedAt:'previous',nmID:123,limit:100});assert.equal(settings.filter.withPhoto,-1);
});

test('photo URLs accept official HTTPS hosts, reject credentials, scripts and lookalike hosts', () => {
  for (const bad of ['javascript:alert(1)', 'https://wbbasket.ru.evil.test/a', 'http://basket-01.wbbasket.ru/a', 'https://user:secret@basket-01.wbbasket.ru/a']) assert.equal(photoUrl({photos:[{big:bad}]}),null);
  assert.equal(photoUrl({photos:[]}),null);
  assert.equal(photoUrl({photos:[{c246x328:'https://basket-01.wbbasket.ru/vol1/a.webp'}]}),'https://basket-01.wbbasket.ru/vol1/a.webp');
});

test('incremental bounded cache, rate pacing, 403 backoff, empty catalog and tenant scope', async t => {
  const original=credentials.tokenFor;credentials.tokenFor=async()=> 'synthetic-only';
  t.after(()=>credentials.tokenFor=original);
  const statements=[];
  const client={query:async(sql,args)=>{statements.push({sql,args});return {rows:sql.startsWith('SELECT id,')?[{id:'credential',updated_at:'2026-09-10 12:00:00.123456+00',photo_cursor:{updatedAt:'previous',nmID:1}}]:[]};}};
  let calls=0,waits=0;
  const out=await syncPhotos(client,'warehouse-A','company-A',{wait:async ms=>{assert.ok(ms>=600);waits++;},fetchPage:async(_,cursor)=>{
    calls++;assert.equal(cursor.nmID,calls===1?1:calls);return {cards:[{nmID:calls+1,photos:[]}],cursor:{updatedAt:'next-'+calls,nmID:calls+1,total:100}};
  }});
  assert.equal(calls,5);assert.equal(waits,4);assert.equal(out.complete,false);
  const inserts=statements.filter(x=>x.sql.startsWith('INSERT'));
  assert.equal(inserts.length,5);assert.deepEqual(inserts[0].args.slice(0,4),['credential','warehouse-A','company-A','2026-09-10 12:00:00.123456+00']);
  statements.length=0;
  const denied=await syncPhotos(client,'warehouse-A','company-A',{fetchPage:async()=>{throw Object.assign(new Error('no access'),{status:403});}});
  assert.equal(denied.unavailable,true);assert.equal(statements.at(-1).args[1],360);
  statements.length=0;
  await syncPhotos(client,'warehouse-A','company-A',{fetchPage:async()=>({cards:[],cursor:{total:0}})});
  assert.equal(statements.at(-1).args[1],JSON.stringify({updatedAt:'previous',nmID:1}));assert.equal(statements.at(-1).args[2],30);
  assert.equal((await syncPhotos({query:async()=>({rows:[]})},'w','c')).skipped,true);
});

test('public WB photo: the server is found by probing, remembered, and nothing is invented', async () => {
  const { findPublicPhoto } = require('../src/marketplaces/photos');
  const asked = [];
  const on41 = async (url) => { asked.push(url); return url.startsWith('https://basket-41.wbbasket.ru/'); };
  assert.equal(await findPublicPhoto('985393681', { probe: on41 }),
    'https://basket-41.wbbasket.ru/vol9853/part985393/985393681/images/c246x328/1.webp');
  // Соседняя карточка того же тома — с первого запроса: сервер запомнен.
  asked.length = 0;
  await findPublicPhoto('985393999', { probe: on41 });
  assert.equal(asked.length, 1);
  assert.equal(await findPublicPhoto('123', { probe: async () => false }), null);
  assert.equal(await findPublicPhoto('not-a-number', { probe: async () => true }), null);
});

test('public WB photos are probed outside a database transaction', async () => {
  const { syncPublicPhotos } = require('../src/marketplaces/photos');
  let inTx = false; const probedInTx = []; const writes = [];
  const client = { query: async (sql, params) => {
    if (/FROM marketplace_credentials/.test(sql)) return { rows: [{ id: 'cred', updated_at: 'v1' }] };
    if (/WITH ids AS/.test(sql)) return { rows: [{ nm_id: '985393681' }] };
    writes.push(params); return { rows: [] };
  } };
  const run = async (fn) => { inTx = true; try { return await fn(client); } finally { inTx = false; } };
  const probe = async (url) => { probedInTx.push(inTx); return url.startsWith('https://basket-41.'); };
  const out = await syncPublicPhotos(run, 'wh', 'co', { probe });
  assert.deepEqual([...new Set(probedInTx)], [false]);
  assert.equal(out.found, 1);
  assert.match(writes[0][4], /basket-41/);
});
