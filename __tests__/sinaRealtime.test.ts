import { parseSinaLine } from '@/lib/datasource/SinaRealtime';

function sinaLine(code: string): string {
  const fields = Array.from({ length: 32 }, () => '0');
  fields[0] = '微導納米';
  fields[1] = '100.00';
  fields[2] = '108.80';
  fields[3] = '91.00';
  fields[4] = '100.00';
  fields[5] = '87.04';
  fields[8] = '12407352';
  fields[30] = '2026-08-31';
  fields[31] = '15:00:00';
  return `var hq_str_sh${code}="${fields.join(',')}"`;
}

describe('SinaRealtime parser', () => {
  test('保留科創板並帶出來源交易日供收盤交叉確認', () => {
    expect(parseSinaLine(sinaLine('688356'))).toMatchObject({
      code: '688356',
      date: '2026-08-31',
      open: 100,
      high: 100,
      low: 87.04,
      close: 91,
      volume: 12_407_352,
    });
  });

  test('不接受不在 A 股母體的代碼', () => {
    expect(parseSinaLine(sinaLine('900001'))).toBeNull();
  });
});
