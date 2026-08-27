import fs from 'node:fs';
import path from 'node:path';

const PRODUCT_PATHS = [
  'lib/spec-score/stockType.ts',
  'lib/tide/themeData.ts',
  'lib/tide/marketThemeData.ts',
  'app/api/youtube/teacher-events/route.ts',
  'app/api/youtube/teacher-leaderboard/route.ts',
];

describe('台股產品路徑只使用官方產業分類', () => {
  it.each(PRODUCT_PATHS)('%s 不可重新引用人工題材表', (relativePath) => {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    expect(source).not.toContain("themes/themeMap");
    expect(source).not.toContain('TW_CONCEPT_MAP');
  });

  it('舊的 38 題材績效宣稱不可出現在目前掃描 UI', () => {
    const uiPaths = [
      'features/scan/components/ScanResultsCompact.tsx',
      'features/scan/components/ScanResultsTable.tsx',
      'components/CandidatesPoolPanel.tsx',
      'features/scan/components/SanSeScanCompact.tsx',
    ];
    const source = uiPaths
      .map((relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8'))
      .join('\n');
    expect(source).not.toContain('台股38題材');
    expect(source).not.toContain('面板/網通/生技/被動元件');
    expect(source).not.toContain('最熱題材那段報酬約是後段 2 倍');
  });
});
