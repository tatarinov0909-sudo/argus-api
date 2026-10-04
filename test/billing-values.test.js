const {test}=require('node:test');
const assert=require('node:assert/strict');
const {moneyCents,money,date,period,nextPeriod,uncoveredPeriods}=require('../src/billing/values');
test('деньги считаются целыми копейками без округления ввода',()=>{
  assert.equal(moneyCents('0,10')*3n,30n); assert.equal(money(30n),'0.30');
  for(const v of ['',null,true,'-1','1e3','1.001','NaN']) assert.throws(()=>moneyCents(v));
});
test('ручные счета покрывают свои дни, расписание заполняет только пробелы',()=>{
  assert.deepEqual(uncoveredPeriods('2026-10-01','2026-10-07',[
    {from:'2026-09-29',to:'2026-10-02'},{from:'2026-10-04',to:'2026-10-04'},{from:'2026-10-06',to:'2026-10-08'},
  ]),[{from:'2026-10-03',to:'2026-10-03'},{from:'2026-10-05',to:'2026-10-05'}]);
});
test('существующие даты и произвольный включительный период',()=>{
  assert.throws(()=>date('2026-02-30')); assert.throws(()=>date('2026-13-01'));
  assert.deepEqual(period({month:'2024-02'}),{month:'2024-02',from:'2024-02-01',to:'2024-02-29'});
  assert.equal(period({from:'2026-10-04',to:'2026-10-04'}).to,'2026-10-04');
  assert.throws(()=>period({from:'2026-10-04',to:'2026-10-03'}));
});
test('ежедневный, недельный, месячный и собственный график',()=>{
  assert.equal(nextPeriod('2026-10-04',{cadence:'daily'}),'2026-10-05');
  assert.equal(nextPeriod('2026-10-04',{cadence:'weekly'}),'2026-10-11');
  assert.equal(nextPeriod('2026-10-04',{cadence:'custom',intervalDays:5}),'2026-10-09');
  const s={cadence:'monthly',startDate:'2026-01-31'};
  assert.equal(nextPeriod('2026-01-31',s),'2026-02-28'); assert.equal(nextPeriod('2026-02-28',s),'2026-03-31');
});
