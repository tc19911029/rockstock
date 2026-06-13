/**
 * 合約：陸股回測事件檔 schema 不變量
 *
 * 鎖什麼：
 *   1. (date, agentSource, code) 複合鍵唯一（id 格式 = `${date}:${agentSource}:${code}`）
 *   2. tier / mode / agentSource / sentimentPhase 必在 enum 內
 *   3. scoreBreakdown 的 key ⊆ CN_EMOTION_SIGNAL_SPECS keys（防子分 key 漂移）
 *   4. totalScore ∈ [0, 100]；baseline 形狀（null 或合法 status）
 *
 * 真實檔案存在時逐檔驗證（回填/cron 落地的事件全部過檢）；無檔 → skip。
 */

import { promises as fs } from 'fs';
import path from 'path';
import { CN_EMOTION_SIGNAL_SPECS } from '@/lib/cn-agents/scoring';
import type { CnRecoEventsFile } from '@/lib/cn-agents/backtest/recoTypes';

const EVENTS_DIR = path.join(process.cwd(), 'data', 'cn-agents', 'events');

const TIERS = new Set(['A', 'B', 'C']);
const MODES = new Set(['daban', 'banlu', 'dixi', 'swing', 'watch']);
const SOURCES = new Set(['hard_score_v0', 'master_decision']);
const PHASES = new Set(['frozen', 'repair', 'launch', 'main_rise', 'climax', 'divergence', 'retreat', 'crash']);
const BASELINE_STATUS = new Set(['pending', 'filled', 'no_fill', 'no_data']);
const SPEC_KEYS = new Set(CN_EMOTION_SIGNAL_SPECS.map((s) => s.key as string));

async function listEventFiles(): Promise<string[]> {
  const files = await fs.readdir(EVENTS_DIR).catch(() => [] as string[]);
  return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
}

describe('cn-reco-events schema 合約', () => {
  it('全部事件檔過不變量檢查', async () => {
    const files = await listEventFiles();
    if (files.length === 0) {
      console.warn('cn-reco-events-schema：無事件檔，skip（回填後會自動生效）');
      return;
    }
    for (const f of files) {
      const file = JSON.parse(await fs.readFile(path.join(EVENTS_DIR, f), 'utf-8')) as CnRecoEventsFile;
      expect(file.date).toBe(f.slice(0, 10));
      const ids = new Set<string>();
      for (const e of file.events) {
        // 1. 複合鍵唯一 + id 格式
        expect(e.id).toBe(`${e.date}:${e.agentSource}:${e.code}`);
        expect(ids.has(e.id)).toBe(false);
        ids.add(e.id);
        expect(e.date).toBe(file.date);
        // 2. enum
        expect(TIERS.has(e.tier)).toBe(true);
        expect(MODES.has(e.mode)).toBe(true);
        expect(SOURCES.has(e.agentSource)).toBe(true);
        expect(PHASES.has(e.sentimentPhase)).toBe(true);
        // 3. scoreBreakdown key ⊆ 權重表 keys
        for (const k of Object.keys(e.scoreBreakdown)) {
          expect(SPEC_KEYS.has(k)).toBe(true);
        }
        // 4. 分數界內 + baseline 形狀
        expect(e.totalScore).toBeGreaterThanOrEqual(0);
        expect(e.totalScore).toBeLessThanOrEqual(100);
        expect(/^\d{6}$/.test(e.code)).toBe(true);
        expect(/^\d{6}\.(SS|SZ|BJ)$/.test(e.symbol)).toBe(true);
        if (e.baseline !== null) {
          expect(BASELINE_STATUS.has(e.baseline.status)).toBe(true);
          if (e.baseline.status === 'filled') {
            expect(e.baseline.entry_open).toBeGreaterThan(0);
            expect(e.baseline.base_date).toBeTruthy();
          }
        }
      }
    }
  });
});
