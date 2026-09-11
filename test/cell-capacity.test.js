const test = require('node:test');
const assert = require('node:assert/strict');
const { warehouseSummary } = require('../src/agents/kladovshchik');

test('agent reports occupied addresses and real units without inferring capacity', async () => {
  for (const units of [1,500,50000]) {
    const responses = [
      [{total:3,occupied:1,avg_fill:100}], // Legacy value must not become evidence.
      [{skus:1,units:String(units)}],
      [{quality:'good',qty:String(units)}],[],[{n:0}],
    ];
    const summary=await warehouseSummary({query:async()=>({rows:responses.shift()})},'unit-test-warehouse');
    assert.equal(summary.totalUnits,units);
    assert.equal(summary.cellsTotal,3);
    assert.equal(summary.cellsOccupied,1);
    assert.equal(summary.cellsFree,2);
    assert.equal(summary.averageFillOfOccupiedPct,null);
    assert.equal(summary.capacityKnown,false);
    assert.match(summary.capacityNote,/не задана/);
  }
});
