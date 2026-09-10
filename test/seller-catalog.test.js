const {test}=require('node:test');
const assert=require('node:assert/strict');
const {combineCatalog}=require('../src/sellers/catalog');
test('WB identifiers remain separate from internal codes and preserve multiple listings',()=>{
  const rows=combineCatalog([
    {sku:'PB001',nm_id:'123456',article:'seller-code',category:'Чай'},
    {sku:'PB001',nm_id:'123456',article:'seller-code',category:'Чай'},
    {sku:'PB001',nm_id:'987654',article:'seller-code-2',category:'Чай'},
    {sku:'PB002',nm_id:null,article:null,category:null},
  ]);
  assert.equal(rows.length,2);assert.equal(rows[0].cards.length,2);
  assert.equal(rows[0].cards[0].nmId,'123456');assert.equal(rows[0].sku,'PB001');
  assert.equal(rows[1].cards.length,0);assert.equal(rows[1].category,'Без категории');
});
test('non-WB internal IDs cannot appear as nmID',()=>{
  assert.deepEqual(combineCatalog([{sku:'PB001',nm_id:'PB001'}])[0].cards,[]);
});
