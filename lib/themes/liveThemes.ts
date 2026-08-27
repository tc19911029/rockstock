/**
 * 盤中即時「官方產業完整名單」。
 *
 * 與 hotThemeScan 的差別：
 *   - hotThemeScan =「反著做」：全市場掃熱門股 → 反推題材，一個題材只列「今天在熱」那幾檔
 *     （記憶體常只剩 4 檔），看不到完整成分。
 *   - liveThemes  =「正著列」：用 TWSE／TPEx 官方產業完整名單，每檔配 L2 即時快照的
 *     當日漲跌，全部成分股都列（今天沒成交/停牌 → changePercent=null 顯示「—」）。
 *
 * 與 sectorRanking（盤後多日排行）共用同一份官方產業母體 → 盤中即時與盤後排行一致，
 * 只差「即時當日」vs「盤後多日」。純顯示層，不參與選股（鐵則 #5）；只讀單一 L2 快照（鐵則 #3）。
 */

import { readIntradaySnapshot, readMABase } from '@/lib/datasource/IntradayCache';
import { isLimitUp as calcLimitUp } from '@/lib/utils/limitRules';
import {
  TW_OFFICIAL_CLASSIFICATION,
  fetchTwOfficialIndustryRoster,
  groupOfficialIndustryStocks,
} from '@/lib/datasource/TWOfficialIndustry';

export interface LiveThemeMember {
  code: string;
  name: string;
  /** 當日漲跌幅 %（L2 快照；今天沒成交/停牌 = null） */
  changePercent: number | null;
  /** 當日成交量（張） */
  volume: number | null;
  /** 今日量 / 前 5 日均量（無 MA base = null） */
  volRatio: number | null;
  isLimitUp: boolean;
}

export interface LiveTheme {
  theme: string;
  /** 題材完整成分股數 */
  memberCount: number;
  /** 有即時報價的檔數 */
  quotedCount: number;
  /** 上漲家數（有報價且 > 0） */
  upCount: number;
  /** 成分股平均漲跌 %（只算有報價的；全缺 = null） */
  avgChange: number | null;
  /** 最強成分漲跌 % */
  maxChange: number | null;
  topStock: { code: string; name: string; changePercent: number } | null;
  members: LiveThemeMember[];
}

export interface LiveThemeRosterFile {
  date: string;
  generatedAt: string;
  /** 來源 L2 真正的更新時間；generatedAt 只代表本次重新聚合時間。 */
  snapshotUpdatedAt: string;
  market: 'TW';
  classification: typeof TW_OFFICIAL_CLASSIFICATION;
  themeCount: number;
  themes: LiveTheme[];
}

const bareCode = (s: string) => s.replace(/\.(TW|TWO)$/i, '');

/** 用官方產業完整名單 + L2 即時快照算每個產業的全成分股當日漲跌。無快照回 null。 */
export async function buildLiveThemeRoster(date: string): Promise<LiveThemeRosterFile | null> {
  const snap = await readIntradaySnapshot('TW', date);
  if (!snap || snap.quotes.length === 0) return null;

  const qmap = new Map<string, { changePercent: number; volume: number; close: number; prevClose: number }>();
  for (const q of snap.quotes) qmap.set(bareCode(q.symbol), { changePercent: q.changePercent, volume: q.volume, close: q.close, prevClose: q.prevClose });

  // 量比：前 5 日均量為基準（MA base），今日量 = 快照量
  const maBase = await readMABase('TW', snap.date).catch(() => null);
  const volRatioOf = (code: string, today: number | null): number | null => {
    const e = maBase?.data[code];
    if (!e || e.volumes.length < 5 || today == null) return null;
    const last5 = e.volumes.slice(-5);
    const avg = last5.reduce((a, b) => a + b, 0) / last5.length;
    if (!avg || avg <= 0) return null;
    return +(today / avg).toFixed(2);
  };

  const roster = await fetchTwOfficialIndustryRoster();
  const industryGroups = groupOfficialIndustryStocks(roster);
  const themes: LiveTheme[] = [];
  for (const { industry: theme, stocks } of industryGroups) {
    const members: LiveThemeMember[] = stocks.map((s) => {
      const q = qmap.get(s.code);
      const cp = q?.changePercent ?? null;
      const vol = q?.volume ?? null;
      return {
        code: s.code,
        name: s.name,
        changePercent: cp,
        volume: vol,
        volRatio: volRatioOf(s.code, vol),
        // 用真實漲停價判斷（前收 × 1.10 + tick 容忍），不再用 +9.5% 寬估誤判
        isLimitUp: q != null && q.close > 0 && q.prevClose > 0 && calcLimitUp(q.close, q.prevClose, 'TW', s.code),
      };
    });
    const quoted = members.filter((m): m is LiveThemeMember & { changePercent: number } => m.changePercent != null);
    const avgChange = quoted.length ? +(quoted.reduce((a, m) => a + m.changePercent, 0) / quoted.length).toFixed(2) : null;
    const maxChange = quoted.length ? +Math.max(...quoted.map((m) => m.changePercent)).toFixed(2) : null;
    const up = quoted.filter((m) => m.changePercent > 0).length;
    const top = quoted.length ? quoted.reduce((b, m) => (m.changePercent > b.changePercent ? m : b)) : null;
    themes.push({
      theme,
      memberCount: members.length,
      quotedCount: quoted.length,
      upCount: up,
      avgChange,
      maxChange,
      topStock: top ? { code: top.code, name: top.name, changePercent: top.changePercent } : null,
      members,
    });
  }

  // 預設按今日平均漲幅 高→低（無報價題材沉底）
  themes.sort((a, b) => (b.avgChange ?? -Infinity) - (a.avgChange ?? -Infinity));

  return {
    date: snap.date,
    generatedAt: new Date().toISOString(),
    snapshotUpdatedAt: snap.updatedAt,
    market: 'TW',
    classification: TW_OFFICIAL_CLASSIFICATION,
    themeCount: themes.length,
    themes,
  };
}

/** 最近一個有 L2 快照的交易日 */
export async function buildLatestLiveThemeRoster(maxBack = 7): Promise<LiveThemeRosterFile | null> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const base = new Date(`${today}T00:00:00Z`);
  for (let i = 0; i <= maxBack; i++) {
    const iso = new Date(base.getTime() - i * 86400_000).toISOString().slice(0, 10);
    const f = await buildLiveThemeRoster(iso);
    if (f) return f;
  }
  return null;
}
