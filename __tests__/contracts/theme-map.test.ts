/**
 * Contract test: themeMap 代號↔名稱 必須與 stock-master 一致（2026-06-12 A2）
 *
 * 守護：
 *  1. 每個成分股代號存在於 data/youtube/stock-master.json 且名稱完全一致
 *     （鐵則：代號絕不可憑記憶 — 曾因此寫錯 5 個代號）
 *  2. 規格書點名股 100% 覆蓋（六組海外對照的台股側）
 *  3. 題材數 = 37（規格書 25 + 玻璃基板 + 綠能/伺服器電源/高速連接 + 成熟製程 + 2026-06-22 IC設計/矽晶圓/第三代半導體/網通/半導體通路/工具機/自行車）
 */
import fs from 'fs';
import path from 'path';
import { THEME_MAP, THEME_NAMES, allThemeCodes } from '@/lib/themes/themeMap';

interface MasterEntry { code: string; name: string; market: string }

function loadMaster(): Map<string, string> {
  const p = path.join(process.cwd(), 'data', 'youtube', 'stock-master.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as { entries: MasterEntry[] };
  return new Map(raw.entries.map(e => [e.code, e.name]));
}

describe('themeMap contracts', () => {
  const master = loadMaster();

  test('題材數 = 37', () => {
    expect(THEME_NAMES).toHaveLength(37);
  });

  test('每個成分股代號存在於 stock-master 且名稱一致', () => {
    const mismatches: string[] = [];
    for (const [theme, stocks] of Object.entries(THEME_MAP)) {
      for (const s of stocks) {
        const masterName = master.get(s.code);
        if (!masterName) {
          mismatches.push(`${theme}/${s.code} 不存在於 stock-master`);
        } else if (masterName !== s.name) {
          mismatches.push(`${theme}/${s.code} 名稱不一致：themeMap="${s.name}" master="${masterName}"`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('規格書點名股 100% 覆蓋', () => {
    // 規格書 Step 3 六組對照的台股側點名（代號已驗證）
    const SPEC_NAMED = [
      '2408', '2344', '6770', '3006', '8299',          // 記憶體
      '3661', '3443', '3035', '2454', '2379',          // ASIC
      '3081', '4979', '3363', '6442', '3163', '4977',  // CPO/光通訊
      '2382', '3231', '6669', '2376', '3017', '3324', '3653', '8996', // AI伺服器/散熱
      '2327', '2492', '3026', '2375', '6173',          // 被動元件
      '6187', '2467', '3131', '3583', '5443', '6196',  // 半導體設備
    ];
    const covered = new Set(allThemeCodes());
    const missing = SPEC_NAMED.filter(code => !covered.has(code));
    expect(missing).toEqual([]);
  });

  test('每個題材至少 3 檔成分（排名聚合的最低樣本）', () => {
    for (const [theme, stocks] of Object.entries(THEME_MAP)) {
      expect({ theme, n: stocks.length }).toEqual({ theme, n: expect.any(Number) });
      expect(stocks.length).toBeGreaterThanOrEqual(3);
    }
  });
});
