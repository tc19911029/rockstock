import fs from 'node:fs';
import path from 'node:path';

const PRODUCT_PATHS = [
  'lib/spec-score/stockType.ts',
  'lib/tide/themeData.ts',
  'lib/tide/marketThemeData.ts',
  'app/api/youtube/teacher-events/route.ts',
  'app/api/youtube/teacher-leaderboard/route.ts',
];

function productSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(process.cwd(), root), { withFileTypes: true })) {
    const relativePath = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...productSourceFiles(relativePath));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(relativePath);
  }
  return out;
}

describe('台股產品路徑只使用官方產業分類', () => {
  it.each(PRODUCT_PATHS)('%s 不可重新引用人工題材表', (relativePath) => {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    expect(source).not.toContain("themes/themeMap");
    expect(source).not.toContain('TW_CONCEPT_MAP');
  });

  it('全部產品程式不可引用人工台股題材表', () => {
    const allowedDefinitions = new Set([
      'lib/themes/themeMap.ts',
      'lib/scanner/conceptMap.ts',
    ]);
    const offenders = ['app', 'components', 'features', 'lib']
      .flatMap(productSourceFiles)
      .filter((relativePath) => !allowedDefinitions.has(relativePath))
      .filter((relativePath) => {
        const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
        return source.includes('themes/themeMap') || source.includes('TW_CONCEPT_MAP');
      });
    expect(offenders).toEqual([]);
  });

  it('官方產業熱點補歷史資料時使用快照的完整 symbol', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/themes/hotThemeScan.ts'), 'utf8');
    expect(source).toContain('memberPerfTW(symbol');
    expect(source).not.toContain('readCandleFile(`${code}.TW`');
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

  it('Tide 不得重組官方產業或保留人工十大群組', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'app/tide/TideDashboard.tsx'), 'utf8');
    expect(source).not.toContain('expandTideThemes');
    expect(source).not.toContain('TIDE_THEME_GROUPS');
    expect(source).not.toContain('assignThemeGroups');
    expect(source).not.toContain('THEME_MAP');
    expect(source).not.toContain('TW_CONCEPT_MAP');
  });

  it('公開排行與台股熱門產業查詢保持唯讀', () => {
    const routeSource = fs.readFileSync(path.join(process.cwd(), 'app/api/themes/ranking/route.ts'), 'utf8');
    const hotSource = fs.readFileSync(path.join(process.cwd(), 'lib/theme-sanse/todayHot.ts'), 'utf8');
    expect(routeSource).not.toContain('buildSectorRanking');
    expect(routeSource).not.toContain('saveSectorRanking');
    expect(hotSource).not.toContain('buildSectorRanking');
    expect(hotSource).not.toContain('saveSectorRanking');
  });

  it('Tide Pro 用官方市場後綴讀 K 線，不試猜 .TW/.TWO', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/tide/proData.ts'), 'utf8');
    expect(source).toContain('officialContext.symbolByCode.get');
    expect(source).not.toContain('`${symbol}.TW`');
    expect(source).not.toContain('`${symbol}.TWO`');
  });
});
