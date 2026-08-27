import { calculateApproxBrokerConcentration } from '@/lib/chips/approxConcentration';
import { institutionalRecordToInstDay } from '@/lib/chips/institutionalDailySync';
import { calculateDayTradeRatio } from '@/lib/datasource/FinmindChipExtras';
import { parseTpexInstitutionalRows } from '@/lib/datasource/TpexInstitutional';
import { normaliseChipResponse } from '@/lib/agents/agents/chipAgent';
import { assessChipCoverageLevel } from '@/lib/health/chipCoverage';
import { redactSensitiveText } from '@/lib/datasource/curlFetch';

describe('籌碼資料修復契約', () => {
  test('TPEx 法人欄位映射使用外資/投信/自營合計欄', () => {
    const row = Array.from({ length: 24 }, () => '0');
    row[0] = '6488';
    row[1] = '環球晶';
    row[10] = '125,597';
    row[13] = '-13,842';
    row[22] = '79,165';
    row[23] = '190,920';
    expect(parseTpexInstitutionalRows([row])).toEqual([{
      symbol: '6488', name: '環球晶', foreign: 125597, trust: -13842, dealer: 79165, total: 190920,
    }]);
  });

  test('官方法人股數轉逐股快取張數', () => {
    expect(institutionalRecordToInstDay({
      symbol: '2330', name: '台積電', foreign: 1_250_400, trust: -20_400, dealer: 50_500, total: 1_280_500,
    })).toEqual({ foreign: 1250, trust: -20, dealer: 51, total: 1281 });
  });

  test('5 日近似集中度只用有 broker 快照的同日量，且揭露覆蓋率', () => {
    const candles = [1, 2, 3, 4, 5].map(day => ({ date: `2026-08-0${day}`, volume: 1000 }));
    const broker = [1, 2, 4, 5].map(day => ({ date: `2026-08-0${day}`, netDifference: 100 }));
    expect(calculateApproxBrokerConcentration(candles, broker, '2026-08-05', 5)).toEqual({
      value: 10,
      presentDays: 4,
      requiredDays: 5,
      coverage: 0.8,
    });
  });

  test('當沖比有成交量分母時不再固定為 0', () => {
    expect(calculateDayTradeRatio(2_500_000, 10_000_000)).toBe(25);
    expect(calculateDayTradeRatio(2_500_000)).toBe(0);
  });

  test('Chip Agent ground truth 帶入主力集中度與資料來源', () => {
    const chip = normaliseChipResponse({
      chipScore: 60,
      brokerNetBuy: 320,
      brokerConcentration5d: 4.2,
      brokerConcentration20d: -1.1,
      brokerConcentrationCoverage5d: 1,
      brokerConcentrationCoverage20d: 0.95,
      brokerDataDate: '2026-08-27',
      brokerConcentrationSource: 'yahoo_daily_approximate',
      dayTradeRatio: 23.5,
      dayTradeDate: '2026-08-26',
    });
    expect(chip).toMatchObject({
      brokerNetBuy: 320,
      brokerConcentration5d: 4.2,
      brokerConcentration20d: -1.1,
      brokerDataDate: '2026-08-27',
      brokerConcentrationSource: 'yahoo_daily_approximate',
      dayTradeRatio: 23.5,
      dayTradeDate: '2026-08-26',
    });
  });

  test('前 500 法人或主力低於門檻時健康燈正確降級', () => {
    expect(assessChipCoverageLevel(1, 0.99)).toBe('green');
    expect(assessChipCoverageLevel(0.92, 0.99)).toBe('yellow');
    expect(assessChipCoverageLevel(0.89, 0.99)).toBe('red');
    expect(assessChipCoverageLevel(1, 1, 0.93)).toBe('yellow');
  });

  test('curl 錯誤訊息不會洩漏 query token 或 Bearer credential', () => {
    const redacted = redactSensitiveText(
      'curl https://example.test/data?dataset=x&token=secret-123&api_key=also-secret -H Authorization: Bearer abc.def',
    );
    expect(redacted).not.toContain('secret-123');
    expect(redacted).not.toContain('also-secret');
    expect(redacted).not.toContain('abc.def');
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(3);
  });
});
