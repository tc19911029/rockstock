import {
  resolvePartialExitDisplay,
  resolveHoldingProfitTarget,
  resolveSignalPanelActionPlan,
  resolveSignalPanelOperatingMA,
} from '@/lib/portfolio/signalPanelPlan';

describe('訊號面板持倉計畫', () => {
  test('持倉升級長線後改守 MA20', () => {
    expect(resolveSignalPanelOperatingMA('B', 'short')).toBe('MA5');
    expect(resolveSignalPanelOperatingMA('B', 'long')).toBe('MA20');
  });

  test('Q 三均線戰法不被長線模式改寫', () => {
    expect(resolveSignalPanelOperatingMA('Q', 'long')).toBe('MA10');
  });

  test('停利優先讀進場時凍結的型態目標', () => {
    expect(resolveHoldingProfitTarget(100, 128)).toEqual({
      price: 128,
      source: 'entry-pattern',
    });
  });

  test('沒有進場型態快照時才使用 10% 紀律', () => {
    const result = resolveHoldingProfitTarget(100);
    expect(result.source).toBe('rule');
    expect(result.price).toBeCloseTo(110);
  });

  test('持倉戒律只要求續抱警戒，不誤喊立即減碼或買進', () => {
    const result = resolveSignalPanelActionPlan({
      action: 'reduce',
      primaryCategory: 'risk',
      hasPosition: true,
      close: 78.4,
      operatingMA: 'MA5',
      operatingMAValue: 72.32,
      confirmation: '觀察下一根。',
    });
    expect(result.label).toBe('今日動作：續抱警戒、不加碼');
    expect(result.detail).toContain('跌破 MA5 72.32 時全數出場');
  });

  test('硬出場給出明確全數出場與禁止加碼', () => {
    const result = resolveSignalPanelActionPlan({
      action: 'exit',
      primaryCategory: 'exit',
      hasPosition: true,
      close: 273.5,
      operatingMA: 'MA5',
      operatingMAValue: 273.6,
      confirmation: '依紀律執行。',
    });
    expect(result.label).toBe('今日動作：全數出場');
    expect(result.detail).toContain('今日不加碼');
  });

  test('已結束的分批模型顯示歷史分歧，不再寫成今天', () => {
    const result = resolvePartialExitDisplay({
      ended: true,
      endDate: '2026-06-05',
      endWhy: '觸 −5% 停損',
      currentAction: '續抱 3/3',
    });
    expect(result.prefix).toBe('歷史對照');
    expect(result.text).toContain('後續分批模擬不再適用');
    expect(result.text).not.toContain('今天');
  });

  test('空手動作不重複寫兩次維持空手', () => {
    const result = resolveSignalPanelActionPlan({
      action: 'avoid-entry',
      primaryCategory: 'exit',
      hasPosition: false,
      close: 67,
      confirmation: '目前維持空手；先觀察轉弱訊號是否繼續，不預判反轉。',
    });
    expect(result.label).toBe('今日動作：維持空手');
    expect(result.detail).toBe('先觀察轉弱訊號是否繼續，不預判反轉；不預掛進場單。');
    expect(result.detail).not.toContain('維持空手');
  });

  test('確認文字已有不預掛進場單時不重複附加', () => {
    const result = resolveSignalPanelActionPlan({
      action: 'avoid-entry',
      primaryCategory: 'risk',
      hasPosition: false,
      close: 67,
      confirmation: '下一根只檢查戒律是否仍存在，不預掛進場單。',
    });
    expect(result.detail).toBe('下一根只檢查戒律是否仍存在，不預掛進場單。');
  });

  test('正式風控原因優先於操作均線的通用出場文案', () => {
    const result = resolveSignalPanelActionPlan({
      action: 'exit',
      primaryCategory: 'risk',
      hasPosition: true,
      close: 67,
      operatingMA: 'MA5',
      operatingMAValue: 72,
      confirmation: '今日已觸發硬出場。',
      decisiveReason: '趨勢已翻空頭（提早出場）',
    });
    expect(result.detail).toContain('趨勢已翻空頭（提早出場）');
    expect(result.detail).not.toContain('已觸發 MA5');
  });
});
