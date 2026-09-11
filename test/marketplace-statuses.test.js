const { test } = require('node:test');
const assert = require('node:assert/strict');
const wb = require('../src/marketplaces/wb');
const { closeReason, reconcile } = require('../src/marketplaces/statuses');
const { previewData, departureTime } = require('../src/marketplaces/reconciliation');
const { loadMapping } = require('../src/marketplaces/sync');
const { listInvoices } = require('../src/agents/kladovshchik');

test('WB statuses use documented read-only POST with 1..1000 integer order IDs', async t => {
  const previous = global.fetch; t.after(() => { global.fetch = previous; });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => JSON.stringify({ orders: [{ id: 101, supplierStatus: 'cancel', wbStatus: 'canceled' }] }) };
  };
  const statuses = await wb.orderStatuses('synthetic-test-token', ['101', '102']);
  assert.equal(calls[0].url, 'https://marketplace-api.wildberries.ru/api/v3/orders/status');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { orders: [101, 102] });
  assert.equal(statuses[0].id, 101);
  for (const invalid of [[], ['1.1'], ['0'], ['-1'], ['9007199254740992'], Array(1001).fill(1)]) {
    await assert.rejects(() => wb.orderStatuses('synthetic-test-token', invalid));
  }
  assert.equal(calls.length, 1);
  global.fetch = async () => ({ ok: true, text: async () => '{}' });
  await assert.rejects(() => wb.orderStatuses('synthetic-test-token', [101]), /не передал список/);
  global.fetch = async () => ({ok:false,status:401,text:async()=>JSON.stringify({detail:'echo synthetic-test-token'})});
  await assert.rejects(() => wb.orderStatuses('synthetic-test-token',[101]),error=>!error.message.includes('synthetic-test-token')&&error.status===401);
});

test('only explicit terminal WB statuses end demand; removal, missing and unknown statuses never cancel', () => {
  for (const wbStatus of ['canceled', 'canceled_by_client', 'declined_by_client', 'defect', 'canceled_by_carrier']) {
    assert.equal(closeReason({ supplierStatus: 'new', wbStatus }), 'canceled');
  }
  for (const wbStatus of ['sorted', 'sold', 'ready_for_pickup', 'postponed_delivery', 'accepted_by_carrier', 'sent_to_carrier']) {
    assert.equal(closeReason({ supplierStatus: 'confirm', wbStatus }), 'fulfilled');
  }
  assert.equal(closeReason({ supplierStatus: 'complete', wbStatus: 'waiting' }), 'fulfilled');
  assert.equal(closeReason({ supplierStatus: 'cancel', wbStatus: 'waiting' }), 'canceled');
  for (const row of [null, {}, {supplierStatus:'confirm',wbStatus:'waiting'}, {supplierStatus:'new',wbStatus:'new_future_status'}, {supplierStatus:'cancel',wbStatus:'canceled',errors:[{code:404}]}]) {
    assert.equal(closeReason(row), null);
  }
});

test('partial responses, duplicate IDs and unrelated seller IDs do not close local orders; retries do not duplicate journals', async () => {
  const queries = [];
  const invoices = new Map(Array.from({length:5},(_,i) => [String(i+1), {id:String(i+1), number:`WB-${i+1}`, status:'open', mp_closed_at:null, has_picks:i===1, supply_id:null}]));
  const client = { query: async (sql, args) => {
    queries.push({sql,args});
    if (sql.includes('SELECT id, external_id')) return {rows:[...invoices.values()].map(i=>({id:i.id,external_id:i.id}))};
    if (sql.includes('FOR UPDATE OF i')) return {rows:[{...invoices.get(args[2])}]};
    if (sql.includes('mp_supplier_status=$4') && args[5]) invoices.get(args[2]).mp_closed_at='observed';
    return {rows:[{}]};
  }};
  const fetchStatuses = async (_, ids) => {
    assert.deepEqual(ids, ['1','2','3','4','5']);
    return [{id:1,supplierStatus:'cancel',wbStatus:'canceled'},
      {id:2,supplierStatus:'complete',wbStatus:'sorted'},
      {id:3,supplierStatus:'new',wbStatus:'waiting'},
      {id:4,supplierStatus:'cancel',wbStatus:'canceled'},
      {id:4,supplierStatus:'confirm',wbStatus:'waiting'},
      {id:999,supplierStatus:'cancel',wbStatus:'canceled'}];
  };
  const out = await reconcile(client, 'warehouse-A', 'company-A', 'synthetic-test-token', {fetchStatuses});
  assert.deepEqual(out, {checked:3,closed:2,missing:2,conflicts:1});
  assert.equal(queries.filter(q=>q.sql.includes('INSERT INTO journal_entries')).length,2);
  assert.ok(queries.filter(q=>q.sql.includes('UPDATE invoices')).every(q=>q.args[0]==='warehouse-A'&&q.args[1]==='company-A'));
  assert.ok(!queries.some(q=>/UPDATE cell_stock|DELETE FROM cell_stock|INSERT INTO cell_stock|SET status\s*=/.test(q.sql)));
  assert.ok(!queries.some(q=>q.args?.[2]==='999'));
  await reconcile(client, 'warehouse-A', 'company-A', 'synthetic-test-token', {fetchStatuses});
  assert.equal(queries.filter(q=>q.sql.includes('INSERT INTO journal_entries')).length,2);
});

test('status API failure keeps imported data and leaves status timestamps untouched for retry', async () => {
  const queries=[];
  const client={query:async(sql)=>{queries.push(sql);return {rows:[{id:'one',external_id:'123'}]};}};
  const out=await reconcile(client,'w','c','synthetic-test-token',{fetchStatuses:async()=>{throw new Error('unavailable');}});
  assert.match(out.error,/повторится автоматически/);assert.ok(!out.error.includes('unavailable'));assert.equal(out.closed,0);assert.equal(queries.length,1);
});

test('physical resolution is explicit, versioned and unavailable for missing cells or incomplete departure evidence', () => {
  const inv={id:'i',status:'ready',mp_closed_at:'now',mp_close_reason:'canceled',mp_stock_returned_at:null,supply_id:null,fully_picked:true};
  const rows=[{id:'pick',picked_qty:'2',existing_cell_id:'cell',cell_block_id:'cell',sku:'TEST',name:'Test',row_num:1,rack_start:1,rack_end:1,tier_start:1,tier_end:1}];
  const p=previewData(inv,rows);
  assert.equal(p.action,'return_to_cells');assert.equal(p.canResolve,true);
  assert.equal(p.lines[0].qty,2);assert.equal(p.lines[0].cell,'1.1.1');
  assert.notEqual(previewData(inv,[{...rows[0],picked_qty:'3'}]).version,p.version);
  assert.equal(previewData(inv,[{...rows[0],existing_cell_id:null}]).canResolve,false);
  assert.equal(previewData({...inv,mp_stock_returned_at:'done'},rows).resolved,true);
  assert.equal(previewData({...inv,status:'shipped'},rows).canResolve,false);
  assert.equal(previewData({...inv,mp_close_reason:'fulfilled',fully_picked:false},rows).canResolve,false);
  assert.equal(previewData({...inv,mp_close_reason:'fulfilled'},rows).action,'confirm_departed');
});

test('historical departure requires a supplied actual time between final pick and now', () => {
  const rows=[{finished_at:'2026-09-11T10:00:00.000Z'}];
  const now=Date.parse('2026-09-11T12:00:00.000Z');
  for(const value of [undefined,'','not-a-date','2026-09-11','2026-09-11T09:59:59.000Z','2026-09-11T12:00:01.000Z']) {
    assert.throws(()=>departureTime(value,rows,now));
  }
  assert.equal(departureTime('2026-09-11T11:05:00.000Z',rows,now),'2026-09-11T11:05:00.000Z');
  assert.equal(departureTime('2026-09-11T11:05:00Z',rows,now),'2026-09-11T11:05:00.000Z');
  assert.throws(()=>departureTime('2026-02-30T11:05:00.000Z',[],now));
});

test('ambiguous seller article and barcode cannot silently resolve to whichever row was read last', async () => {
  const resolve=await loadMapping({query:async(sql,args)=>{
    assert.deepEqual(args,['warehouse-A','company-A','wb']);
    assert.match(sql,/company_id = \$2/);
    return {rows:[{sku:'SKU-A',mp_article:'SHARED',mp_barcode:'SAME'},{sku:'SKU-B',mp_article:'SHARED',mp_barcode:'SAME'}]};
  }},'warehouse-A','company-A','wb');
  assert.equal(resolve({article:'SHARED',barcodes:['SAME']}),null);
});

test('warehouse agent distinguishes confirmed departure, canceled return and unresolved marketplace delivery', async () => {
  const results=await listInvoices({query:async()=>({rows:[
    {status:'shipped',mp_closed_at:'closed',mp_close_reason:'fulfilled'},
    {status:'ready',mp_closed_at:'closed',mp_close_reason:'canceled',mp_stock_returned_at:'returned'},
    {status:'ready',mp_closed_at:'closed',mp_close_reason:'fulfilled'},
    {status:'shipped',mp_closed_at:'closed',mp_close_reason:'canceled'},
  ]})},'warehouse-A');
  assert.equal(results[0].status,'отгружен');
  assert.match(results[1].status,/товар возвращён в ячейки/);
  assert.match(results[2].status,/физическую отгрузку проверяет склад/);
  assert.match(results[3].status,/отгружен со склада; позднее отменён на WB/);
});
