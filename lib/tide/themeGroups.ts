/** Tide 設定面板的市場題材視覺分組；不改變題材成分或計算。 */
export const TIDE_MARKET_THEME_GROUPS = [
  { id: 'ai', label: 'AI・高速運算', names: ['AI伺服器', '散熱', 'ASIC', 'CPO', '矽光子', '光通訊', '伺服器電源', '高速連接'] },
  { id: 'semiconductor', label: '半導體供應鏈', names: ['記憶體', '先進封裝', 'CoWoS', '半導體設備', '成熟製程', 'IC設計', '矽晶圓', '第三代半導體', '半導體通路', '功率元件'] },
  { id: 'electronics', label: '電子零組件', names: ['被動元件', 'PCB', 'CCL', '玻璃基板', '面板', '網通', '蘋果供應鏈', '車用電子'] },
  { id: 'power', label: '電力・能源', names: ['重電', '電力', '綠能'] },
  { id: 'advanced', label: '先進應用', names: ['機器人', '低軌衛星', '軍工'] },
  { id: 'other', label: '金融・傳產・民生', names: ['航運', '金融', '生技', '工具機', '自行車', '中國政策受惠'] },
] as const;

export function groupTideMarketThemes<T extends { theme: string }>(themes: T[]) {
  const remaining = [...themes].sort((left, right) => left.theme.localeCompare(right.theme, 'zh-Hant'));
  const groups: Array<{ id: string; label: string; themes: T[] }> = TIDE_MARKET_THEME_GROUPS.map((group) => {
    const names = new Set<string>(group.names);
    const matched = remaining.filter((theme) => names.has(theme.theme));
    for (const theme of matched) remaining.splice(remaining.indexOf(theme), 1);
    return { id: group.id, label: group.label, themes: matched };
  });
  if (remaining.length > 0) groups.find((group) => group.id === 'other')?.themes.push(...remaining);
  return groups.filter((group) => group.themes.length > 0);
}
