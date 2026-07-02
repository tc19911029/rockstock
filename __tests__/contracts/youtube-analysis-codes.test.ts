/**
 * Contract test: 所有 data/youtube/analysis/*.json 內的 stock_code/name 必須對應到
 * data/youtube/stock-master.json 內的真實股票。
 *
 * 防 bug：2026-05-24 發現多支 analysis 寫錯代號（鉅橡 8074→8070、緯創 3231→3037、
 * 貿聯 3665→3266、安可 3615→6957）；2026-06-10 又見 4958「臻鼎」應為「臻鼎-KY」。
 *
 * 驗證規則與「寫入時」saveDailyAnalysis 共用同一份 validateAnalysisNames（單一事實來源），
 * 確保「事前防止」與「事後偵測」永遠一致、不會 drift。
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { validateAnalysisNames } from '../../lib/youtube/validateAnalysisNames';
import type { DailyAnalysis } from '../../lib/youtube/analysisStorage';
import type { StockMasterFile } from '../../lib/youtube/stockMaster';

const REPO = path.join(__dirname, '..', '..');
const MASTER_PATH = path.join(REPO, 'data/youtube/stock-master.json');
const ANALYSIS_DIR = path.join(REPO, 'data/youtube/analysis');

describe('youtube analysis stock code/name mappings', () => {
  if (!existsSync(MASTER_PATH) || !existsSync(ANALYSIS_DIR)) {
    it.skip('skipped — data files not present', () => undefined);
    return;
  }

  const master = JSON.parse(readFileSync(MASTER_PATH, 'utf-8')) as StockMasterFile;
  const files = readdirSync(ANALYSIS_DIR).filter(f => f.endsWith('.json'));

  it.each(files)('analysis %s — every stock code maps to a real master entry with matching name', (fname) => {
    const a = JSON.parse(readFileSync(path.join(ANALYSIS_DIR, fname), 'utf-8')) as DailyAnalysis;
    // 與 saveDailyAnalysis 寫入時驗證同一份規則
    const violations = validateAnalysisNames(a, master);
    expect(violations).toEqual([]);
  });
});
