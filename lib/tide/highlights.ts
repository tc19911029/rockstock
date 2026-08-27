/**
 * Tide「今日重點」使用的公開市場題材成分。
 *
 * 這些題材允許一股多題材；行情與法人金額仍只取本地已驗證的官方股票快照。
 * 成分依 tide-tw.app 題材詳情頁在 2026-08-27 公開顯示的名單整理。
 */

export type TideHighlightMember = {
  code: string;
  name: string;
  d1: number | null;
  instAmt: Array<number | null>;
};

export type TideHighlightSourceTheme = { members: TideHighlightMember[] };

export type TideHighlightTheme = {
  theme: string;
  memberCount: number;
  day1Amount: number;
  avgD1: number | null;
};

const HIGHLIGHT_THEME_CODES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['HBM 高頻寬記憶體', ['2408', '2344', '5269', '5388', '2330', '3711', '6515']],
  ['記憶體模組', ['2408', '5269', '5388', '2344', '3260', '2451', '3661', '5289', '4967', '4973', '5469', '8271', '3317', '3265']],
  ['CXL 技術', ['2454', '2344', '8261', '5269', '2408', '5388', '6515', '3035']],
  ['AI 先進封裝', ['3711', '8150', '3680', '2449', '3131', '6147', '2330', '6243', '3037', '3259']],
  ['封測代工', ['3711', '2449', '6147', '8150', '3680', '2369', '2329', '6271', '6435', '6205', '6278', '6261', '6409', '6291', '6257', '6239', '2441', '3583']],
  ['Edge AI AIoT', ['2454', '3443', '6669', '2345', '3014', '2379', '3661', '6515', '6579', '6414', '8234', '3227']],
  ['被動元件 MLCC', ['2327', '2492', '2375', '2438', '6112', '4999', '5222', '6194', '6126', '6173', '6158', '6259', '6266', '5328', '6210', '3026']],
] as const;

export function buildTideHighlightThemes(source: TideHighlightSourceTheme[]): TideHighlightTheme[] {
  const memberByCode = new Map<string, TideHighlightMember>();
  for (const theme of source) {
    for (const member of theme.members) if (!memberByCode.has(member.code)) memberByCode.set(member.code, member);
  }

  return HIGHLIGHT_THEME_CODES.map(([theme, codes]) => {
    const members = codes
      .map((code) => memberByCode.get(code))
      .filter((member): member is TideHighlightMember => member != null);
    const returns = members.map((member) => member.d1).filter((value): value is number => value != null);
    return {
      theme,
      memberCount: members.length,
      day1Amount: members.reduce((sum, member) => sum + (member.instAmt[0] ?? 0), 0),
      avgD1: returns.length > 0 ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    };
  });
}
