import { cnBoard, getLimitMovePct } from '@/lib/utils/limitRules';

describe('cnBoard 陸股板塊判定（科創/創業徽章單一事實）', () => {
  it('科創板 688/689 → star', () => {
    expect(cnBoard('688981.SS')).toBe('star');
    expect(cnBoard('688008.SS')).toBe('star');
    expect(cnBoard('689009.SS')).toBe('star');
  });

  it('創業板 300-302 → chinext', () => {
    expect(cnBoard('300308.SZ')).toBe('chinext');
    expect(cnBoard('301236.SZ')).toBe('chinext');
  });

  it('滬深主板 + 中小板 → main', () => {
    expect(cnBoard('600519.SS')).toBe('main');
    expect(cnBoard('000001.SZ')).toBe('main');
    expect(cnBoard('002594.SZ')).toBe('main');
  });

  it('北交所 / 老三板 8/4/920 → bse', () => {
    expect(cnBoard('830799.BJ')).toBe('bse');
    expect(cnBoard('430139.BJ')).toBe('bse');
    expect(cnBoard('920099.BJ')).toBe('bse');
  });

  it('板塊判定與漲停幅度一致：星/創 20%、主板 10%', () => {
    expect(getLimitMovePct('CN', '688981.SS')).toBe(0.2);
    expect(getLimitMovePct('CN', '300308.SZ')).toBe(0.2);
    expect(getLimitMovePct('CN', '600519.SS')).toBe(0.1);
  });
});
