const test = require('node:test');
const assert = require('node:assert/strict');
const { readPage } = require('../src/sellers/history');

const company = 'a', sku = 'Case-Sensitive';
const cursor = (data) => Buffer.from(JSON.stringify({v:1,company,sku,key:'picked:11111111-1111-1111-1111-111111111111',at:'2026-09-11 01:02:03.123456+00',...data})).toString('base64url');

test('history cursor preserves microseconds and binds to seller and SKU', () => {
  const page = readPage({cursor:cursor()}, company, sku);
  assert.equal(page.limit,50);
  assert.equal(page.cursor.at,'2026-09-11 01:02:03.123456+00');
  assert.throws(()=>readPage({cursor:cursor()},'other',sku),{status:400});
  assert.throws(()=>readPage({cursor:cursor()},company,sku.toUpperCase()),{status:400});
  assert.equal(readPage({cursor:cursor({at:null})},company,sku).cursor.at,null);
});

test('history rejects invalid or unbounded pages', () => {
  for (const limit of [0,101,-1,1.5,'nope',[],['10','20']]) {
    assert.throws(()=>readPage({limit},company,sku),{status:400});
  }
  for (const value of ['bad*',cursor({at:'yesterday'}),cursor({key:'anything'}),cursor({v:2}),cursor({at:undefined})]) {
    assert.throws(()=>readPage({cursor:value},company,sku),{status:400});
  }
  assert.equal(readPage({limit:'100'},company,sku).limit,100);
});
