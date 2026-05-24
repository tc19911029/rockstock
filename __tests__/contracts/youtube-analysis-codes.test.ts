/**
 * Contract test: 所有 data/youtube/analysis/*.json 內的 stock_code/name 必須對應到
 * data/youtube/stock-master.json 內的真實股票。
 *
 * 防 bug：2026-05-24 發現多支 analysis 寫錯代號（鉅橡 8074→8070、緯創 3231→3037、
 * 貿聯 3665→3266、安可 3615→6957）。修好後加這個 guard 避免重蹈覆轍。
 *
 * 容忍：master 端的命名標記差異 (世界 vs 世界先進、矽力*-KY vs 矽力-KY) 不算錯，
 * 用 norm() 拿掉星號/破折號/空白後比對。
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

interface MasterEntry { code: string; name: string; market: string; aliases?: string[]; }
interface MasterFile { fetched_at: string; entries: MasterEntry[]; }
interface Matched { code: string; name: string; }
interface Mention { matched: Matched | null; }
interface Scoring { stock_code: string; stock_name: string; }
interface Analysis {
  date: string;
  weak_signal_stocks?: Mention[];
  high_consensus_stocks?: Mention[];
  stock_scoring?: Scoring[];
}

const REPO = path.join(__dirname, '..', '..');
const MASTER_PATH = path.join(REPO, 'data/youtube/stock-master.json');
const ANALYSIS_DIR = path.join(REPO, 'data/youtube/analysis');

function norm(s: string): string {
  return s.replace(/[\*\-\s]/g, '');
}

describe('youtube analysis stock code/name mappings', () => {
  if (!existsSync(MASTER_PATH) || !existsSync(ANALYSIS_DIR)) {
    it.skip('skipped — data files not present', () => undefined);
    return;
  }

  const master = JSON.parse(readFileSync(MASTER_PATH, 'utf-8')) as MasterFile;
  // master entry → { name, aliases } — 分析寫的名稱命中其中任一個都算對
  const byCode = new Map(master.entries.map(e => [e.code, { name: e.name, aliases: e.aliases ?? [] }]));
  // 已知 master 短名 vs 常見全名差異（master 為求精簡只存核心，但常見講法是全名）
  // 這份白名單必須對應到「同一支股票、只是顯示名不同」的真實情況；不能放實際是兩支股票的代號。
  const KNOWN_NAME_VARIANTS: Record<string, string[]> = {
    '5347': ['世界先進'],  // master: '世界'
    '6415': ['矽力-KY'],    // master: '矽力*-KY' （* 為除權息標記，會隨時間變動）
  };
  const files = readdirSync(ANALYSIS_DIR).filter(f => f.endsWith('.json'));

  it.each(files)('analysis %s — every stock code maps to a real master entry with matching name', (fname) => {
    const fp = path.join(ANALYSIS_DIR, fname);
    const a = JSON.parse(readFileSync(fp, 'utf-8')) as Analysis;

    const violations: string[] = [];

    const checkPair = (where: string, code: string, name: string) => {
      const real = byCode.get(code);
      if (real === undefined) {
        violations.push(`${where}: code ${code} (${name}) not in stock-master`);
        return;
      }
      const acceptable = new Set([
        norm(real.name),
        ...real.aliases.map(norm),
        ...(KNOWN_NAME_VARIANTS[code] ?? []).map(norm),
      ]);
      if (!acceptable.has(norm(name))) {
        violations.push(`${where}: code ${code} mapped to "${name}" but master/aliases are [${[real.name, ...real.aliases].join(', ')}]`);
      }
    };

    for (const s of a.weak_signal_stocks ?? []) {
      if (s.matched) checkPair('weak_signal', s.matched.code, s.matched.name);
    }
    for (const s of a.high_consensus_stocks ?? []) {
      if (s.matched) checkPair('high_consensus', s.matched.code, s.matched.name);
    }
    for (const s of a.stock_scoring ?? []) {
      checkPair('stock_scoring', s.stock_code, s.stock_name);
    }

    expect(violations).toEqual([]);
  });
});
