import {
  adjustTwCandlesForTechnicalUse,
  applyVerifiedTwCorporateActions,
  parseTpexCorporateAction,
  parseTpexMechanicalAction,
  parseTwseCorporateAction,
  parseTwseMechanicalAction,
} from '@/lib/datasource/twCorporateActionAdjust';

describe('TW corporate action technical adjustment', () => {
  it('uses the audited 6669 fallback without depending on a live exchange response', async () => {
    const result = await adjustTwCandlesForTechnicalUse('6669.TW', [
      { date: '2026-09-01', open: 7115, high: 7800, low: 7050, close: 7800, volume: 2855 },
      { date: '2026-09-02', open: 2790, high: 2875, low: 2585, close: 2610, volume: 10870 },
    ]);
    expect(result.events).toHaveLength(1);
    expect(result.candles[0].close).toBeCloseTo(2614.99, 5);
    expect(result.candles[0].volume).toBe(8516);
  });

  it('parses the official 6669 stock-dividend calculation and keeps the event-day bar raw', () => {
    const action = parseTwseCorporateAction('6669.TW', '2026-09-02', {
      stat: 'ok',
      data: [['115年09月02日', '6669', '緯穎', '7,800.00', '2,614.99', '5,185.002642', '權']],
    }, {
      stat: 'ok',
      data: [['6669  ', '緯穎', '0 元／股', '', '1,982.8 股']],
    });
    expect(action).not.toBeNull();
    const raw = [
      { date: '2026-09-01', open: 7115, high: 7800, low: 7050, close: 7800, volume: 2855 },
      { date: '2026-09-02', open: 2790, high: 2875, low: 2585, close: 2610, volume: 10870 },
    ];
    const adjusted = applyVerifiedTwCorporateActions(raw, [action!]);
    expect(adjusted[0].close).toBeCloseTo(2614.99, 5);
    expect(adjusted[0].volume).toBe(Math.round(2855 * 2.9828));
    expect(adjusted[1]).toEqual(raw[1]);
    expect(raw[0].close).toBe(7800);
  });

  it('parses TPEx stock distributions from the official result table', () => {
    const action = parseTpexCorporateAction('1815.TWO', '2026-09-09', {
      tables: [{ data: [['115/09/09', '1815', '富喬', '135.00', '128.10', '', '', '', '除權息', '', '', '', '', '0.5', '50.00171092']] }],
    });
    expect(action).toMatchObject({ source: 'TPEx', shareRatio: 1.05000171092 });
  });

  it('parses official TWSE capital-reduction shares instead of inferring them from price alone', () => {
    const action = parseTwseMechanicalAction('2380.TW', '2026-06-29', {
      stat: 'OK',
      data: [['115/06/29', '2380', '虹光', '6.60', '23.86', '26.20', '21.50', '23.85', '--', '彌補虧損', '2380,20260616']],
    }, 'capital-reduction', {
      stat: 'OK',
      data: [['2380', '虹光', '115/06/17', '276.58171000 股']],
    });
    expect(action).toMatchObject({ kind: 'capital-reduction', shareRatio: 0.27658171 });
  });

  it('parses official TPEx par-value changes and cash reductions', () => {
    const parValue = parseTpexMechanicalAction('5904.TWO', '2026-08-10', {
      tables: [{ data: [['1150810', '5904', '寶雅*', '720.00', '72.00', '', '', '', '<table><tr><th>變更股票面額換股率:</th><td>10.00000000</td></tr></table>']] }],
    }, 'par-value-change');
    const reduction = parseTpexMechanicalAction('3152.TWO', '2026-06-30', {
      tables: [{ data: [['1150630', '3152', '璟德', '208.00', '360.24', '', '', '', '0.00', '現金減資', '<table><tr><th>每壹仟股換發新股票:</th><td>565.31945000&nbsp股</td></tr></table>']] }],
    }, 'capital-reduction');
    expect(parValue).toMatchObject({ kind: 'par-value-change', shareRatio: 10 });
    expect(reduction).toMatchObject({ kind: 'capital-reduction', shareRatio: 0.56531945 });
  });
});
