/** Tide 原站公開的 10 大分類、110 個題材。此處是 Tide 顯示層的單一事實來源。 */
export const TIDE_MARKET_THEME_GROUPS = [
  {
    id: 'semiconductor', label: '半導體', names: [
      '矽晶圓', '晶圓代工', '封測代工', 'AI 先進封裝', '晶圓廠設備', '前段製程材料',
      '前段製程設備', '封裝量測自動化', '封裝製程機台', 'IC 測試服務', '類比與功率 IC',
      '客製 ASIC 矽智財', 'HPC 與網通 IC', 'CPU 與 Agentic AI', 'NOR Flash 利基記憶體',
      '記憶體模組', 'HBM 高頻寬記憶體', 'CXL 技術', '第三代半導體', '顯示驅動 IC',
      'IC 通路', '導線架與化學品', '半導體・其他', '廠務工程',
    ],
  },
  {
    id: 'ai-hardware', label: 'AI與電子硬體', names: [
      'AI 伺服器組裝', '液冷散熱', '氣冷與核心組件', 'PCB 載板', '被動元件 MLCC',
      '功率電感', '電容器', '電阻與被動保護', '高速光模組', '矽光子與 CPO', 'AI 互連元件',
      '連接器 工業消費', '車用連接器', '軟板', 'PCB 硬板製造', '玻璃基板', '玻纖布',
      'AI PC 筆電與平板', '智慧型手機', 'EMS 電子代工', '機殼與滑軌', '面板產業',
      'MicroLED 顯示供應鏈', '光學鏡頭', '光感測與元件', 'AR VR XR 光學', 'Edge AI AIoT',
      '高速交換器與無線網路', '低軌衛星', '石英頻率控制', '日本被動元件', '光電・其他',
      '其他電子・其他', '通信網路・其他', '電子通路・其他', '電子零組件・其他', '電腦週邊・其他',
    ],
  },
  {
    id: 'software-cloud', label: '軟體雲端資安', names: [
      '雲端與 MSP', '企業 SaaS', '資安防護', '數位雲端・其他', '資訊服務・其他',
    ],
  },
  {
    id: 'green-energy', label: '綠能與電力', names: [
      '離岸風電', '太陽能產業', '儲能系統整合', '電池關鍵材料', '電芯製造與電池模組',
      'BBU 電池備援', '電源供應器', '電器電纜', '資源環保工業', '油電燃氣',
      '綠能環保・其他', '電器電纜・其他',
    ],
  },
  { id: 'finance', label: '金融', names: ['銀行金融', '金融保險・其他'] },
  { id: 'shipping', label: '航運物流', names: ['貨櫃航運', '散裝航運', '航空與空運', '陸運與宅配'] },
  {
    id: 'traditional', label: '傳產製造', names: [
      '工業自動化', 'CNC 工具機', '精密機構件', '石化與塑膠產業', '國防軍工', '其他產業',
      '化學工業・其他', '塑膠・其他', '橡膠', '水泥', '汽車工業・其他', '玻璃陶瓷',
      '紡織成衣', '造紙', '鋼鐵金屬', '電機機械・其他',
    ],
  },
  {
    id: 'consumer', label: '民生消費', names: [
      '電商零售', '居家生活', '文化創意', '觀光餐旅', '貿易百貨', '農業科技', '運動休閒', '食品飲料',
    ],
  },
  { id: 'construction', label: '營建地產', names: ['營建地產'] },
  { id: 'biotech', label: '生技醫療', names: ['生技醫療'] },
] as const;

export const TIDE_THEME_NAMES = TIDE_MARKET_THEME_GROUPS.flatMap((group) => [...group.names]);

export function groupTideMarketThemes<T extends { theme: string }>(themes: T[]) {
  const byName = new Map(themes.map((theme) => [theme.theme, theme]));
  const configured = new Set<string>(TIDE_THEME_NAMES);
  const groups: Array<{ id: string; label: string; themes: T[] }> = TIDE_MARKET_THEME_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    themes: group.names.map((name) => byName.get(name)).filter((theme): theme is T => theme != null),
  }));
  const extra = themes.filter((theme) => !configured.has(theme.theme));
  if (extra.length > 0) groups.find((group) => group.id === 'traditional')?.themes.push(...extra);
  return groups.filter((group) => group.themes.length > 0);
}
