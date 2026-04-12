import { getLastTradingDay } from '../lib/datasource/marketHours';
import { isTradingDay } from '../lib/utils/tradingDay';

console.log('=== TW 過去20個交易日 (到 2026-04-10) ===');
const twDays: string[] = [];
let d = new Date('2026-04-10T12:00:00');
while (twDays.length < 20) {
  const s = d.toISOString().split('T')[0]!;
  if (isTradingDay(s, 'TW')) twDays.push(s);
  d.setDate(d.getDate() - 1);
}
console.log(twDays.join('\n'));

console.log('\n=== CN 過去20個交易日 (到 2026-04-10) ===');
const cnDays: string[] = [];
d = new Date('2026-04-10T12:00:00');
while (cnDays.length < 20) {
  const s = d.toISOString().split('T')[0]!;
  if (isTradingDay(s, 'CN')) cnDays.push(s);
  d.setDate(d.getDate() - 1);
}
console.log(cnDays.join('\n'));
