/**
 * 股票類型分類（specScore 4 套權重用；2026-06-12 A3）
 * 依 themeMap 題材歸屬判定 — 單一事實在 lib/themes/themeMap.ts。
 */
import { THEME_MAP } from '@/lib/themes/themeMap';
import type { SpecStockType } from './weights';

/** 題材 → 股票類型（優先序：memory > ai_tech > cyclical > general） */
const MEMORY_THEMES = new Set(['記憶體']);
const AI_TECH_THEMES = new Set([
  'AI伺服器', '散熱', 'ASIC', 'CPO', '矽光子', '光通訊',
  'CoWoS', '半導體設備', '先進封裝', 'PCB', 'CCL', '低軌衛星',
]);
const CYCLICAL_THEMES = new Set(['航運', '面板', '被動元件']);

let codeThemesCache: Map<string, string[]> | null = null;

/** 裸代號 → 所屬題材清單 */
export function themesOfCode(code: string): string[] {
  if (!codeThemesCache) {
    codeThemesCache = new Map();
    for (const [theme, stocks] of Object.entries(THEME_MAP)) {
      for (const s of stocks) {
        const arr = codeThemesCache.get(s.code);
        if (arr) arr.push(theme);
        else codeThemesCache.set(s.code, [theme]);
      }
    }
  }
  return codeThemesCache.get(code) ?? [];
}

export function classifyStockType(code: string): SpecStockType {
  const themes = themesOfCode(code);
  if (themes.some(t => MEMORY_THEMES.has(t))) return 'memory';
  if (themes.some(t => AI_TECH_THEMES.has(t))) return 'ai_tech';
  if (themes.some(t => CYCLICAL_THEMES.has(t))) return 'cyclical';
  return 'general';
}
