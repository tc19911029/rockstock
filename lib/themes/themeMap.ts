/**
 * 26 題材清單 × 成分股（2026-06-12 A2 起；2026-06-19 加玻璃基板 + 補各題材漏網龍頭，單一事實）
 *
 * 來源：使用者選股規格書 Step 4 的 25 題材 + Step 3/5 點名股 + 2026-06 市場概念股審查補強，
 * 成分沿用/校正 lib/scanner/conceptMap.ts 的概念分類。
 * 所有代號↔名稱已逐一對 data/youtube/stock-master.json 驗證
 * （合約測試 __tests__/contracts/theme-map.test.ts 持續守護）。
 *
 * 用途 = 板塊強弱排名（sectorRanking）與題材階段「顯示層」分類。
 * 紅線：不參與選股 gate、不入 pool 計分（鐵則 #5）。
 *
 * 設計註記：
 * - 同一檔股票可屬多個題材（CPO ⊂ 光通訊、CoWoS設備 ≈ 半導體設備）— 刻意保留，
 *   排名是 per-theme 聚合不互斥
 * - 「電力」與「重電」v1 成分相同（規格書分列、台股實際是同一族群）
 * - 「中國政策受惠」成分最弱（內需收成股 proxy），排名參考價值低 — 顯示時敬陪末座可接受
 */

export interface ThemeStock {
  /** 裸代號 */
  code: string;
  /** 中文名（與 stock-master 一致，含 -KY 後綴） */
  name: string;
}

export const THEME_MAP: Record<string, ThemeStock[]> = {
  'AI伺服器': [
    { code: '2382', name: '廣達' }, { code: '3231', name: '緯創' },
    { code: '6669', name: '緯穎' }, { code: '2376', name: '技嘉' },
    { code: '2324', name: '仁寶' }, { code: '3706', name: '神達' },
    { code: '2353', name: '宏碁' }, { code: '2317', name: '鴻海' },
    { code: '2356', name: '英業達' }, { code: '4938', name: '和碩' },
    { code: '2357', name: '華碩' }, { code: '2377', name: '微星' },
  ],
  '散熱': [
    { code: '3017', name: '奇鋐' }, { code: '3324', name: '雙鴻' },
    { code: '3653', name: '健策' }, { code: '8996', name: '高力' },
    { code: '2421', name: '建準' }, { code: '6230', name: '尼得科超眾' },
    { code: '3338', name: '泰碩' }, { code: '3013', name: '晟銘電' },
  ],
  'ASIC': [
    { code: '3661', name: '世芯-KY' }, { code: '3443', name: '創意' },
    { code: '3035', name: '智原' }, { code: '2454', name: '聯發科' },
    { code: '2379', name: '瑞昱' }, { code: '3529', name: '力旺' },
    { code: '6533', name: '晶心科' },
  ],
  'CPO': [
    { code: '4977', name: '眾達-KY' }, { code: '3363', name: '上詮' },
    { code: '6442', name: '光聖' }, { code: '3081', name: '聯亞' },
    { code: '4979', name: '華星光' }, { code: '3163', name: '波若威' },
    { code: '6451', name: '訊芯-KY' }, { code: '3105', name: '穩懋' },
    { code: '3450', name: '聯鈞' }, { code: '2455', name: '全新' },
  ],
  '矽光子': [
    { code: '3363', name: '上詮' }, { code: '3081', name: '聯亞' },
    { code: '6442', name: '光聖' }, { code: '4979', name: '華星光' },
    { code: '6451', name: '訊芯-KY' }, { code: '3105', name: '穩懋' },
    { code: '2455', name: '全新' },
  ],
  '光通訊': [
    { code: '3081', name: '聯亞' }, { code: '4979', name: '華星光' },
    { code: '3363', name: '上詮' }, { code: '6442', name: '光聖' },
    { code: '3163', name: '波若威' }, { code: '4977', name: '眾達-KY' },
    { code: '2345', name: '智邦' }, { code: '6451', name: '訊芯-KY' },
    { code: '3105', name: '穩懋' }, { code: '3450', name: '聯鈞' },
    { code: '2455', name: '全新' },
  ],
  '記憶體': [
    { code: '2408', name: '南亞科' }, { code: '2344', name: '華邦電' },
    { code: '6770', name: '力積電' }, { code: '3006', name: '晶豪科' },
    { code: '8299', name: '群聯' }, { code: '2337', name: '旺宏' },
    { code: '4967', name: '十銓' }, { code: '3260', name: '威剛' },
    { code: '5289', name: '宜鼎' }, { code: '8271', name: '宇瞻' },
  ],
  '被動元件': [
    { code: '2327', name: '國巨*' }, { code: '2492', name: '華新科' },
    { code: '3026', name: '禾伸堂' }, { code: '2375', name: '凱美' },
    { code: '6173', name: '信昌電' }, { code: '2478', name: '大毅' },
    { code: '3236', name: '千如' }, { code: '2472', name: '立隆電' },
    { code: '6449', name: '鈺邦' },
  ],
  'PCB': [
    { code: '3037', name: '欣興' }, { code: '8046', name: '南電' },
    { code: '3189', name: '景碩' }, { code: '6269', name: '台郡' },
    { code: '4958', name: '臻鼎-KY' }, { code: '2368', name: '金像電' },
    { code: '3044', name: '健鼎' }, { code: '2313', name: '華通' },
    { code: '2367', name: '燿華' },
  ],
  'CCL': [
    { code: '2383', name: '台光電' }, { code: '6213', name: '聯茂' },
    { code: '6274', name: '台燿' },
  ],
  '先進封裝': [
    { code: '3711', name: '日月光投控' }, { code: '6239', name: '力成' },
    { code: '6147', name: '頎邦' }, { code: '8150', name: '南茂' },
    { code: '2449', name: '京元電子' },
  ],
  'CoWoS': [
    { code: '6187', name: '萬潤' }, { code: '3131', name: '弘塑' },
    { code: '3583', name: '辛耘' }, { code: '6196', name: '帆宣' },
    { code: '2467', name: '志聖' }, { code: '5443', name: '均豪' },
  ],
  '半導體設備': [
    { code: '6187', name: '萬潤' }, { code: '2467', name: '志聖' },
    { code: '3131', name: '弘塑' }, { code: '3583', name: '辛耘' },
    { code: '5443', name: '均豪' }, { code: '6196', name: '帆宣' },
    { code: '6510', name: '精測' }, { code: '3680', name: '家登' },
    { code: '3413', name: '京鼎' }, { code: '2404', name: '漢唐' },
  ],
  // 玻璃基板 / TGV（玻璃穿孔）先進封裝載板 — 2026 驗證年，Intel 玻璃基板登場帶動台廠
  '玻璃基板': [
    // 載板廠轉玻璃核心載板（欣興＝Intel R&D 夥伴；南電/景碩同步切入）
    { code: '3037', name: '欣興' }, { code: '8046', name: '南電' },
    { code: '3189', name: '景碩' },
    // 玻璃加工（正達熱成型 TGV、TPK-KY 觸控玻璃轉 TGV 試產）
    { code: '3149', name: '正達' }, { code: '3673', name: 'TPK-KY' },
    // TGV 雷射鑽孔 / 封裝設備
    { code: '6207', name: '雷科' }, { code: '6664', name: '群翊' },
    { code: '8027', name: '鈦昇' },
    // 高階玻璃材料（中釉類晶玻璃陶瓷、晶呈氣相蝕刻）
    { code: '1809', name: '中釉' }, { code: '4768', name: '晶呈科技' },
  ],
  '機器人': [
    { code: '2049', name: '上銀' }, { code: '1590', name: '亞德客-KY' },
    { code: '6215', name: '和椿' }, { code: '4583', name: '台灣精銳' },
    { code: '1536', name: '和大' }, { code: '4540', name: '全球傳動' },
    { code: '2359', name: '所羅門' }, { code: '4576', name: '大銀微系統' },
  ],
  '重電': [
    { code: '1513', name: '中興電' }, { code: '1519', name: '華城' },
    { code: '1503', name: '士電' }, { code: '1504', name: '東元' },
    { code: '1514', name: '亞力' },
  ],
  '電力': [
    { code: '1513', name: '中興電' }, { code: '1519', name: '華城' },
    { code: '1503', name: '士電' }, { code: '1504', name: '東元' },
    { code: '1514', name: '亞力' },
  ],
  '軍工': [
    { code: '2634', name: '漢翔' }, { code: '8033', name: '雷虎' },
    { code: '3005', name: '神基' }, { code: '6753', name: '龍德造船' },
    { code: '5371', name: '中光電' },
  ],
  '生技': [
    { code: '6547', name: '高端疫苗' }, { code: '4743', name: '合一' },
    { code: '6446', name: '藥華藥' }, { code: '1760', name: '寶齡富錦' },
    { code: '4147', name: '中裕' }, { code: '6472', name: '保瑞' },
    { code: '1795', name: '美時' },
  ],
  '面板': [
    { code: '2409', name: '友達' }, { code: '3481', name: '群創' },
    { code: '6116', name: '彩晶' }, { code: '8069', name: '元太' },
  ],
  '車用電子': [
    { code: '2231', name: '為升' }, { code: '2201', name: '裕隆' },
    { code: '2308', name: '台達電' }, { code: '8261', name: '富鼎' },
    { code: '6279', name: '胡連' }, { code: '1533', name: '車王電' },
    { code: '2497', name: '怡利電' },
  ],
  '航運': [
    { code: '2603', name: '長榮' }, { code: '2609', name: '陽明' },
    { code: '2615', name: '萬海' }, { code: '2618', name: '長榮航' },
    { code: '2610', name: '華航' }, { code: '2637', name: '慧洋-KY' },
    { code: '2606', name: '裕民' },
  ],
  '金融': [
    { code: '2881', name: '富邦金' }, { code: '2882', name: '國泰金' },
    { code: '2883', name: '凱基金' }, { code: '2884', name: '玉山金' },
    { code: '2885', name: '元大金' }, { code: '2886', name: '兆豐金' },
    { code: '2891', name: '中信金' }, { code: '2892', name: '第一金' },
    { code: '5880', name: '合庫金' }, { code: '2890', name: '永豐金' },
    { code: '2880', name: '華南金' }, { code: '2887', name: '台新新光金' },
  ],
  '低軌衛星': [
    { code: '3491', name: '昇達科' }, { code: '2455', name: '全新' },
    { code: '4968', name: '立積' }, { code: '2313', name: '華通' },
    { code: '6285', name: '啟碁' }, { code: '2314', name: '台揚' },
    { code: '3105', name: '穩懋' },
  ],
  '蘋果供應鏈': [
    { code: '2317', name: '鴻海' }, { code: '3008', name: '大立光' },
    { code: '2354', name: '鴻準' }, { code: '2474', name: '可成' },
    { code: '4958', name: '臻鼎-KY' }, { code: '4938', name: '和碩' },
    { code: '2382', name: '廣達' }, { code: '6269', name: '台郡' },
    { code: '2330', name: '台積電' },
  ],
  '中國政策受惠': [
    { code: '1216', name: '統一' }, { code: '2912', name: '統一超' },
    { code: '9904', name: '寶成' }, { code: '1101', name: '台泥' },
    { code: '9921', name: '巨大' }, { code: '1210', name: '大成' },
  ],
};

export const THEME_NAMES = Object.keys(THEME_MAP);

/** 全部題材成分的去重裸代號 */
export function allThemeCodes(): string[] {
  const set = new Set<string>();
  for (const stocks of Object.values(THEME_MAP)) {
    for (const s of stocks) set.add(s.code);
  }
  return [...set];
}

/** code → 所屬題材名（一檔可屬多題材，如 3081 在 CPO/矽光子/光通訊） */
const CODE_TO_THEMES: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  for (const [theme, stocks] of Object.entries(THEME_MAP)) {
    for (const s of stocks) (m[s.code] ??= []).push(theme);
  }
  return m;
})();

export function themesOf(code: string): string[] {
  return CODE_TO_THEMES[code] ?? [];
}

/** 同題材其他成分股（去重、排除自己）— 相對族群報酬的基準群 */
export function peersOf(code: string): string[] {
  const peers = new Set<string>();
  for (const t of themesOf(code)) {
    for (const s of THEME_MAP[t]) if (s.code !== code) peers.add(s.code);
  }
  return [...peers];
}
