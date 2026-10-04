const { HttpError } = require('../middleware/errorHandler');
const MAX_CENTS = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value, label = 'продавец') {
  if (typeof value!=='string' || !UUID.test(value)) throw new HttpError(400, `Неверный ${label}`);
  return value;
}
function moneyCents(value, maxRubles = 1000000000000n) {
  if (!['string','number'].includes(typeof value)) throw new HttpError(400, 'Сумма — число с точностью до копейки');
  const s = String(value).trim().replace(',', '.');
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(s)) throw new HttpError(400, 'Сумма — неотрицательное число с точностью до копейки');
  const [r,c=''] = s.split('.');
  const n = BigInt(r)*100n + BigInt(c.padEnd(2,'0'));
  if (n>maxRubles*100n || n>MAX_CENTS) throw new HttpError(400, 'Сумма слишком велика');
  return n;
}
const money = (cents) => { const n=BigInt(cents); return `${n/100n}.${String(n%100n).padStart(2,'0')}`; };
function date(value, label='Дата') {
  const s=String(value || ''), parsed=new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s.slice(0,4)<'2000' || s.slice(0,4)>'2199'
    || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==s) throw new HttpError(400, `${label} — существующая дата ГГГГ-ММ-ДД`);
  return s;
}
function addDays(day,days) { const at=new Date(`${day}T00:00:00Z`); at.setUTCDate(at.getUTCDate()+days); return at.toISOString().slice(0,10); }
function period({month,from,to}) {
  if (from || to) { from=date(from,'Начало периода'); to=date(to,'Конец периода'); }
  else {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) throw new HttpError(400,'Укажите месяц ГГГГ-ММ или даты периода');
    from=date(`${month}-01`); const next=new Date(`${from}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth()+1); to=addDays(next.toISOString().slice(0,10),-1);
  }
  if (from>to || (Date.parse(to)-Date.parse(from))/86400000>365) throw new HttpError(400,'Период — от одного до 366 дней');
  return {month:month || null,from,to};
}
function nextPeriod(from,s) {
  if (s.cadence!=='monthly') return addDays(from,s.cadence==='daily'?1:s.cadence==='weekly'?7:s.intervalDays);
  const at=new Date(`${from}T00:00:00Z`),anchor=Number(s.startDate.slice(8,10));
  at.setUTCDate(1); at.setUTCMonth(at.getUTCMonth()+1);
  const end=new Date(at); end.setUTCMonth(end.getUTCMonth()+1); end.setUTCDate(0);
  at.setUTCDate(Math.min(anchor,end.getUTCDate())); return at.toISOString().slice(0,10);
}
function uncoveredPeriods(from,to,covered) {
  const out=[]; let start=from;
  for(const r of covered) {
    if(r.from>start) out.push({from:start,to:addDays(r.from,-1)});
    if(r.to>=start) start=addDays(r.to,1);
    if(start>to) break;
  }
  if(start<=to) out.push({from:start,to});
  return out;
}
module.exports={MAX_CENTS,uuid,moneyCents,money,date,addDays,period,nextPeriod,uncoveredPeriods};
