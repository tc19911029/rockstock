/**
 * 股票類型分類（specScore 4 套權重用；2026-06-12 A3）
 * 只依 candidate 已附帶的 TWSE／TPEx 官方產業判定，不再讀人工題材名單。
 */
import type { SpecStockType } from './weights';

const AI_TECH_INDUSTRIES = new Set([
  '半導體業', '電腦及週邊設備業', '通信網路業', '電子零組件業',
  '資訊服務業', '其他電子業', '數位雲端',
]);
const CYCLICAL_INDUSTRIES = new Set([
  '水泥工業', '塑膠工業', '紡織纖維', '玻璃陶瓷', '造紙工業',
  '鋼鐵工業', '橡膠工業', '汽車工業', '航運業', '油電燃氣業',
]);

export function classifyStockType(officialIndustry?: string | null): SpecStockType {
  if (officialIndustry && AI_TECH_INDUSTRIES.has(officialIndustry)) return 'ai_tech';
  if (officialIndustry && CYCLICAL_INDUSTRIES.has(officialIndustry)) return 'cyclical';
  return 'general';
}
