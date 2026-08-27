import fs from 'node:fs';
import path from 'node:path';
import { buildTideHighlightThemes } from '@/lib/tide/highlights';
import type { SectorRankingFile } from '@/lib/themes/sectorRanking';

describe('Tide 今日重點題材', () => {
  const ranking = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'data/sectors/TW/2026-08-27.json'), 'utf8'),
  ) as SectorRankingFile;
  const themes = buildTideHighlightThemes(ranking.themes);
  const byName = new Map(themes.map((theme) => [theme.theme, theme]));

  test('依當日法人金額重現前三買超題材', () => {
    const top = [...themes].sort((left, right) => right.day1Amount - left.day1Amount).slice(0, 3);
    expect(top.map((theme) => theme.theme)).toEqual(['HBM 高頻寬記憶體', '記憶體模組', 'CXL 技術']);
    expect(top.map((theme) => +(theme.day1Amount / 100_000_000).toFixed(2))).toEqual([347.51, 228.21, 226.77]);
  });

  test('依當日法人金額重現前三賣超題材', () => {
    const bottom = [...themes].sort((left, right) => left.day1Amount - right.day1Amount).slice(0, 3);
    expect(bottom.map((theme) => theme.theme)).toEqual(['封測代工', 'Edge AI AIoT', '被動元件 MLCC']);
    expect(bottom.map((theme) => +(theme.day1Amount / 100_000_000).toFixed(2))).toEqual([-46.56, -34.46, -28.75]);
  });

  test('公開題材成分完整進入計算', () => {
    expect(byName.get('HBM 高頻寬記憶體')?.memberCount).toBe(7);
    expect(byName.get('記憶體模組')?.memberCount).toBe(14);
    expect(byName.get('CXL 技術')?.memberCount).toBe(8);
    expect(byName.get('AI 先進封裝')?.memberCount).toBe(10);
    expect(byName.get('封測代工')?.memberCount).toBe(18);
    expect(byName.get('Edge AI AIoT')?.memberCount).toBe(12);
    expect(byName.get('被動元件 MLCC')?.memberCount).toBe(16);
  });
});
