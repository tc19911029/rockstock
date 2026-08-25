/**
 * Contract test: themeMap 代號↔名稱 必須與 stock-master 一致（2026-06-12 A2）
 *
 * 守護：
 *  1. 每個成分股代號存在於 data/youtube/stock-master.json 且名稱完全一致
 *     （鐵則：代號絕不可憑記憶 — 曾因此寫錯 5 個代號）
 *  2. 規格書點名股 100% 覆蓋（六組海外對照的台股側）
 *  3. 題材數 = 38（規格書 25 + 玻璃基板 + 綠能/伺服器電源/高速連接 + 成熟製程 + 2026-06-22 IC設計/矽晶圓/第三代半導體/網通/半導體通路/工具機/自行車）
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

  test('題材數 = 38', () => {
    expect(THEME_NAMES).toHaveLength(38);
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

  test('2026-08-26 CPO／矽光子／光通訊稽核名單完整且維持子集合關係', () => {
    const codes = (theme: string) => new Set(THEME_MAP[theme].map(stock => stock.code));
    const cpo = codes('CPO');
    const siliconPhotonics = codes('矽光子');
    const opticalComms = codes('光通訊');

    const auditedCpo = [
      '2303', '2317', '2330', '2345', '2360', '2382', '2409',
      '2426', '2449', '2454', '2458', '2489', '3008', '3264',
      '3265', '3289', '3443', '3587', '3711', '3714', '4971',
      '4991', '6147', '6187', '6197', '6223', '6257', '6426',
      '6510', '6515', '6669', '6706', '6830', '6854', '7728', '7769',
    ];
    const auditedSiliconPhotonics = [
      '2303', '2317', '2330', '2345', '2360', '2449', '2454', '2458',
      '3008', '3264', '3265', '3289', '3443', '3587', '3711',
      '3665', '3714', '4908', '4971', '4991', '6147', '6187',
      '6197', '6223', '6257', '6271', '6426', '6510', '6515',
      '6669', '6706', '6830',
      '7728', '7769',
    ];

    expect(auditedCpo.filter(code => !cpo.has(code))).toEqual([]);
    expect(auditedSiliconPhotonics.filter(code => !siliconPhotonics.has(code))).toEqual([]);
    expect([...cpo].filter(code => !opticalComms.has(code))).toEqual([]);
    expect([...siliconPhotonics].filter(code => !opticalComms.has(code))).toEqual([]);
    expect(['2409', '2426', '2489', '6854'].filter(code => siliconPhotonics.has(code))).toEqual([]);
    expect(['4903', '6271', '6526', '6530', '8011'].filter(code => cpo.has(code))).toEqual([]);
  });

  test('2026-08-26 全題材稽核的核心修正不回歸', () => {
    const codes = (theme: string) => new Set(THEME_MAP[theme].map(stock => stock.code));

    expect([...codes('ASIC')].filter(code => ['5269'].includes(code))).toEqual(['5269']);
    expect(codes('ASIC').has('2379')).toBe(false);
    expect(['2330', '3481'].filter(code => !codes('先進封裝').has(code))).toEqual([]);
    expect(codes('CoWoS').has('2330')).toBe(true);
    expect(codes('玻璃基板').has('3481')).toBe(true);
    expect(codes('AI伺服器').has('5274')).toBe(true);
    expect(['2308', '2317'].filter(code => !codes('機器人').has(code))).toEqual([]);
    expect(['2360', '6706', '7728', '7769'].filter(code => !codes('半導體設備').has(code))).toEqual([]);
    expect(['2409', '2454', '2457'].filter(code => !codes('低軌衛星').has(code))).toEqual([]);
    expect(codes('伺服器電源').has('3665')).toBe(true);
  });

  test('每個題材內沒有重複代號', () => {
    for (const [theme, stocks] of Object.entries(THEME_MAP)) {
      const codes = stocks.map(stock => stock.code);
      expect({ theme, duplicates: codes.filter((code, i) => codes.indexOf(code) !== i) })
        .toEqual({ theme, duplicates: [] });
    }
  });

  test('每個題材至少 3 檔成分（排名聚合的最低樣本）', () => {
    for (const [theme, stocks] of Object.entries(THEME_MAP)) {
      expect({ theme, n: stocks.length }).toEqual({ theme, n: expect.any(Number) });
      expect(stocks.length).toBeGreaterThanOrEqual(3);
    }
  });
});
