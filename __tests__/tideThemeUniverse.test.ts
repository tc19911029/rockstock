import fs from 'node:fs';
import path from 'node:path';
import { buildTideMarketThemeRanking } from '@/lib/tide/themeUniverse';
import { TIDE_THEME_NAMES } from '@/lib/tide/themeGroups';
import type { SectorRankingFile } from '@/lib/themes/sectorRanking';

describe('Tide 110 題材母體', () => {
  const official = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'data/sectors/TW/2026-08-27.json'), 'utf8'),
  ) as SectorRankingFile;
  const tide = buildTideMarketThemeRanking(official);

  test('名稱與順序完整等於原站公開的 110 題材', () => {
    expect(tide.themes).toHaveLength(110);
    expect(tide.themes.map((theme) => theme.theme)).toEqual(TIDE_THEME_NAMES);
    expect(new Set(tide.themes.map((theme) => theme.industryId)).size).toBe(110);
  });

  test('每個題材都有官方快照可驗證的成分', () => {
    const officialByCode = new Map(official.themes.flatMap((theme) => theme.members).map((member) => [member.code, member]));
    for (const theme of tide.themes) {
      expect(theme.members.length).toBeGreaterThan(0);
      for (const member of theme.members) expect(member).toBe(officialByCode.get(member.code));
    }
  });

  test('題材允許重疊但不冒充交易所互斥產業', () => {
    expect(tide.classification).toMatchObject({ kind: 'market_theme', overlapping: true });
    expect(tide.universe.membershipCount).toBeGreaterThan(tide.universe.stockCount);
  });

  test('當日法人排行不會被廣泛產業別重複計算扭曲', () => {
    const day1Amount = (theme: (typeof tide.themes)[number]) =>
      theme.members.reduce((sum, member) => sum + (member.instAmt[0] ?? 0), 0);
    const top = [...tide.themes].sort((left, right) => day1Amount(right) - day1Amount(left)).slice(0, 10);
    const bottom = [...tide.themes].sort((left, right) => day1Amount(left) - day1Amount(right)).slice(0, 3);
    expect(top.map((theme) => theme.theme)).toEqual([
      'HBM 高頻寬記憶體', '記憶體模組', 'CXL 技術', 'AI 先進封裝', 'CPU 與 Agentic AI',
      'NOR Flash 利基記憶體', '矽光子與 CPO', 'EMS 電子代工', '智慧型手機', 'PCB 載板',
    ]);
    expect(bottom.map((theme) => theme.theme)).toEqual(['封測代工', 'Edge AI AIoT', '被動元件 MLCC']);
  });
});
