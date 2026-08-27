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

const TIDE_EXACT_THEME_ENTRIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['HBM 高頻寬記憶體', ['2408', '2344', '5269', '5388', '2330', '3711', '6515']],
  ['記憶體模組', ['2408', '5269', '5388', '2344', '3260', '2451', '3661', '5289', '4967', '4973', '5469', '8271', '3317', '3265']],
  ['CXL 技術', ['2454', '2344', '8261', '5269', '2408', '5388', '6515', '3035']],
  ['AI 先進封裝', ['3711', '8150', '3680', '2449', '3131', '6147', '2330', '6243', '3037', '3259']],
  ['封測代工', ['3711', '2449', '6147', '8150', '3680', '2369', '2329', '6271', '6435', '6205', '6278', '6261', '6409', '6291', '6257', '6239', '2441', '3583']],
  ['Edge AI AIoT', ['2454', '3443', '6669', '2345', '3014', '2379', '3661', '6515', '6579', '6414', '8234', '3227']],
  ['被動元件 MLCC', ['2327', '2492', '2375', '2438', '6112', '4999', '5222', '6194', '6126', '6173', '6158', '6259', '6266', '5328', '6210', '3026']],
  ['CPU 與 Agentic AI', ['2330', '2454', '3443', '3661', '5347', '3035', '2379', '6515']],
  ['NOR Flash 利基記憶體', ['2344', '5351', '2337', '8261', '3014', '8104', '8054', '8299', '3006']],
  ['晶圓代工', ['2330', '2303', '5347', '6770', '3707', '3035', '6515', '7828', '2323', '3372', '3059']],
  ['矽光子與 CPO', ['3105', '3081', '8121', '4979', '3450', '6243', '2454', '3037', '3363']],
  ['AI PC 筆電與平板', ['2357', '2376', '4938', '2353', '2454', '2382', '3017', '2356', '2474', '3706', '2324', '2377', '2425', '2301', '2364', '2365', '2352', '3673', '3611', '3625']],
  ['銀行金融', ['2881', '2882', '2891', '2880', '2884', '2885', '2886', '2887', '2890', '2892', '2883', '2889', '2801', '2812', '5876', '5880']],
  ['EMS 電子代工', ['2317', '2354', '2382', '4938', '3231', '2356', '2308', '6285', '3706', '2429', '2459', '2340', '4994']],
  ['智慧型手機', ['2317', '2354', '2392', '4938', '3231', '3008', '3406', '2474', '2356']],
  ['PCB 載板', ['3037', '8046', '3189', '6213', '3149', '8213', '2367', '3044', '6201', '6155', '6141', '6224', '3294', '3021']],
];

export const TIDE_EXACT_THEME_CODES = Object.freeze(
  Object.fromEntries(TIDE_EXACT_THEME_ENTRIES),
) as Readonly<Record<string, readonly string[]>>;

const TIDE_HIGHLIGHT_THEME_NAMES = new Set(TIDE_EXACT_THEME_ENTRIES.slice(0, 7).map(([theme]) => theme));

export function buildTideHighlightThemes(source: TideHighlightSourceTheme[]): TideHighlightTheme[] {
  const memberByCode = new Map<string, TideHighlightMember>();
  for (const theme of source) {
    for (const member of theme.members) if (!memberByCode.has(member.code)) memberByCode.set(member.code, member);
  }

  return TIDE_EXACT_THEME_ENTRIES.filter(([theme]) => TIDE_HIGHLIGHT_THEME_NAMES.has(theme)).map(([theme, codes]) => {
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
