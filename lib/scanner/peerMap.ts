/**
 * 海外同業對照表（純顯示層 — 不入任何選股分數 / gate，鐵則 #5）
 *
 * 用途：台股題材股（記憶體 / ASIC / CPO / AI伺服器 / 被動元件 / 半導體設備）的
 * 海外領先股動能，是判斷「台股是落後補漲還是自己短炒」的參考；
 * 記憶體股的海外動能（MU / SK hynix / Kioxia）同時當 DRAM/NAND 報價方向 proxy。
 *
 * 單一事實：題材 → { 台股成分, 海外領先股 } 的對照只能改這裡（風格仿 conceptMap.ts）。
 * 消費端：
 *   - app/api/cron/fetch-global-peers（抓海外日K → data/overseas/candles/）
 *   - app/api/overseas/peers（d1/d5/d20/d60 對照 API）
 *   - app/overseas（對照頁 UI）
 *
 * ⚠ 台股代號已逐一對 data/youtube/stock-master.json 驗證（2026-06-12），
 *   後綴依 master 的 market 欄（TWSE → .TW、TPEx → .TWO）對齊 L1 檔名。
 *   海外 ticker 已逐一對 Yahoo Finance v8 chart 驗證存在
 *   （東京 .T 後綴、首爾 .KS 後綴，與 lib/utils/symbols.ts 的偵測規則一致）。
 */

export interface PeerTWStock {
  /** 完整代號（含 .TW/.TWO 後綴，可直接讀 L1 data/candles/TW/{symbol}.json） */
  symbol: string;
  /** 純數字代號 */
  code: string;
  name: string;
}

export interface PeerOverseasStock {
  /** Yahoo Finance ticker：美股無後綴、東京 .T、首爾 .KS、指數 ^ 前綴 */
  ticker: string;
  name: string;
}

export interface PeerTheme {
  /** URL/key 用的英文 id */
  id: string;
  /** 顯示用題材名 */
  theme: string;
  /** 一句話：這組海外動能代表什麼 */
  note?: string;
  twStocks: PeerTWStock[];
  overseas: PeerOverseasStock[];
}

export const PEER_THEMES: PeerTheme[] = [
  {
    id: 'memory',
    theme: '記憶體',
    note: '海外動能同時當 DRAM/NAND 報價方向 proxy',
    twStocks: [
      { symbol: '2408.TW', code: '2408', name: '南亞科' },
      { symbol: '2344.TW', code: '2344', name: '華邦電' },
      { symbol: '6770.TW', code: '6770', name: '力積電' },
      { symbol: '3006.TW', code: '3006', name: '晶豪科' },
      { symbol: '8299.TWO', code: '8299', name: '群聯' },
    ],
    overseas: [
      { ticker: 'MU', name: '美光 Micron' },
      { ticker: 'SNDK', name: 'SanDisk' },
      { ticker: 'WDC', name: '威騰 Western Digital' },
      { ticker: '285A.T', name: '鎧俠 Kioxia' },
      { ticker: '005930.KS', name: '三星電子 Samsung' },
      { ticker: '000660.KS', name: 'SK 海力士 SK hynix' },
    ],
  },
  {
    id: 'asic',
    theme: 'ASIC / IC設計',
    twStocks: [
      { symbol: '3661.TW', code: '3661', name: '世芯-KY' },
      { symbol: '3443.TW', code: '3443', name: '創意' },
      { symbol: '3035.TW', code: '3035', name: '智原' },
      { symbol: '2454.TW', code: '2454', name: '聯發科' },
      { symbol: '2379.TW', code: '2379', name: '瑞昱' },
    ],
    overseas: [
      { ticker: 'AVGO', name: '博通 Broadcom' },
      { ticker: 'MRVL', name: '邁威爾 Marvell' },
      { ticker: 'NVDA', name: '輝達 NVIDIA' },
      { ticker: 'AMD', name: '超微 AMD' },
      { ticker: 'ARM', name: '安謀 Arm' },
    ],
  },
  {
    id: 'cpo',
    theme: 'CPO / 光通訊',
    twStocks: [
      { symbol: '3081.TWO', code: '3081', name: '聯亞' },
      { symbol: '4979.TWO', code: '4979', name: '華星光' },
      { symbol: '3363.TWO', code: '3363', name: '上詮' },
      { symbol: '6442.TW', code: '6442', name: '光聖' },
      { symbol: '3163.TWO', code: '3163', name: '波若威' },
      { symbol: '4977.TW', code: '4977', name: '眾達-KY' },
    ],
    overseas: [
      { ticker: 'COHR', name: 'Coherent' },
      { ticker: 'LITE', name: 'Lumentum' },
      { ticker: 'AAOI', name: 'Applied Optoelectronics' },
      { ticker: 'ANET', name: 'Arista Networks' },
      { ticker: 'CSCO', name: '思科 Cisco' },
    ],
  },
  {
    id: 'ai-server',
    theme: 'AI伺服器 / 散熱',
    twStocks: [
      { symbol: '2382.TW', code: '2382', name: '廣達' },
      { symbol: '3231.TW', code: '3231', name: '緯創' },
      { symbol: '6669.TW', code: '6669', name: '緯穎' },
      { symbol: '2376.TW', code: '2376', name: '技嘉' },
      { symbol: '3017.TW', code: '3017', name: '奇鋐' },
      { symbol: '3324.TWO', code: '3324', name: '雙鴻' },
      { symbol: '3653.TW', code: '3653', name: '健策' },
      { symbol: '8996.TW', code: '8996', name: '高力' },
    ],
    overseas: [
      { ticker: 'SMCI', name: '美超微 Super Micro' },
      { ticker: 'DELL', name: '戴爾 Dell' },
      { ticker: 'HPE', name: 'HPE' },
      { ticker: 'VRT', name: 'Vertiv' },
      { ticker: 'ETN', name: '伊頓 Eaton' },
    ],
  },
  {
    id: 'passive',
    theme: '被動元件',
    twStocks: [
      { symbol: '2327.TW', code: '2327', name: '國巨' },
      { symbol: '2492.TW', code: '2492', name: '華新科' },
      { symbol: '3026.TW', code: '3026', name: '禾伸堂' },
      { symbol: '2375.TW', code: '2375', name: '凱美' },
      { symbol: '6173.TWO', code: '6173', name: '信昌電' },
    ],
    overseas: [
      { ticker: '6981.T', name: '村田 Murata' },
      { ticker: '6762.T', name: 'TDK' },
      { ticker: '6976.T', name: '太陽誘電 Taiyo Yuden' },
    ],
  },
  {
    id: 'semi-equip',
    theme: '半導體設備 / 先進封裝',
    twStocks: [
      { symbol: '6187.TWO', code: '6187', name: '萬潤' },
      { symbol: '2467.TW', code: '2467', name: '志聖' },
      { symbol: '3131.TWO', code: '3131', name: '弘塑' },
      { symbol: '3583.TW', code: '3583', name: '辛耘' },
      { symbol: '5443.TWO', code: '5443', name: '均豪' },
      { symbol: '6196.TW', code: '6196', name: '帆宣' },
    ],
    overseas: [
      { ticker: 'ASML', name: '艾司摩爾 ASML' },
      { ticker: 'AMAT', name: '應用材料 Applied Materials' },
      { ticker: 'LRCX', name: '科林研發 Lam Research' },
      { ticker: 'KLAC', name: '科磊 KLA' },
      { ticker: '8035.T', name: '東京威力科創 Tokyo Electron' },
      { ticker: '6857.T', name: '愛德萬 Advantest' },
      { ticker: '6146.T', name: 'Disco' },
    ],
  },
];

/** 指數參考清單（不屬於任一題材，頂部總覽用） */
export const PEER_REFERENCE_TICKERS: PeerOverseasStock[] = [
  { ticker: '^SOX', name: '費城半導體指數' },
  { ticker: '^IXIC', name: 'NASDAQ 綜合指數' },
  { ticker: 'TSM', name: '台積電 ADR' },
];

/** 全部需要抓日K的海外 ticker（題材 + 指數參考，去重） */
export function getAllOverseasTickers(): string[] {
  const set = new Set<string>();
  for (const theme of PEER_THEMES) {
    for (const o of theme.overseas) set.add(o.ticker);
  }
  for (const r of PEER_REFERENCE_TICKERS) set.add(r.ticker);
  return Array.from(set);
}
