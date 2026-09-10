const {test}=require('node:test');
const assert=require('node:assert/strict');
const {prepareInventoryExport:prepare}=require('../src/sellers/export');
const identity={seller:{id:'seller-a',name:'Test'},warehouse:{id:'warehouse-a'}};
const row={sku:'A',name:'Test',barcode:'0000123456789',stockKnown:true,onHand:100,ordered:30,available:70,countedAt:'2026-09-10T10:00:00Z'};
test('preserves text barcode and three separate unit quantities',()=>{
  const {snapshot,readiness}=prepare([row],identity);
  assert.equal(readiness.ready,true);assert.equal(snapshot.items[0].barcode,'0000123456789');
  assert.deepEqual([snapshot.items[0].onHand,snapshot.items[0].inAssembly,snapshot.items[0].available],[100,30,70]);
  assert.equal(snapshot.quantityMode,'absolute');assert.equal(snapshot.missingItems,'unchanged');
});
test('stable snapshot ID across ordering and download time; changes with quantity or seller',()=>{
  const b={...row,sku:'B',barcode:'00002'};
  const a=prepare([row,b],identity,'2026-09-10T10:00:00Z').snapshot;
  assert.equal(a.snapshotId,prepare([b,row],identity,'2026-09-10T11:00:00Z').snapshot.snapshotId);
  assert.notEqual(a.snapshotId,prepare([{...row,available:69},b],identity).snapshot.snapshotId);
  assert.notEqual(a.snapshotId,prepare([row,b],{...identity,seller:{id:'b',name:'Test'}}).snapshot.snapshotId);
});
test('unknown stock blocks the whole snapshot, known zero can be exported',()=>{
  assert.equal(prepare([{...row,stockKnown:false,onHand:null,available:null}],identity).snapshot,null);
  assert.equal(prepare([{...row,onHand:0,ordered:0,available:0}],identity).readiness.ready,true);
});
test('empty, missing, ambiguous barcodes and invalid quantities are rejected',()=>{
  for(const rows of [[],[{...row,barcode:null}],[row,{...row,sku:'B'}],[{...row,barcode:'123\n'}],
    [{...row,onHand:-1}],[{...row,ordered:1.2}],[{...row,available:NaN}],[{...row,onHand:Number.MAX_SAFE_INTEGER+1}]]) {
    assert.equal(prepare(rows,identity).readiness.ready,false);
  }
});
