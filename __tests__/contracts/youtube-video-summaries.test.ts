/**
 * Contract test: analysis 檔的 video_summaries 欄位（2026-07 每日節目總結報告）
 * + buildHoldingAlerts 持倉 join 純函式。
 *
 * 守門員（向下相容是核心斷言）：
 *   - 舊 analysis 檔沒有 video_summaries → trivially pass
 *   - 欄位若存在則必須合法：
 *     watch_priority ∈ {must_watch, skim, skip}
 *     market_stance（若有）∈ {bullish, bearish, neutral, mixed}
 *     video_id / source_id / source_name / title / summary / watch_reason 非空字串
 *     summary.length ≥ 20（防止改寫標題充數）
 *     key_stocks[].code 匹配 /^\d{4,6}[A-Z]*$/（TW 4 碼含 KY 尾碼 / CN 6 碼）
 *   - buildHoldingAlerts：
 *     後綴剝除 join（"6770.TW" ↔ mention code "6770"）
 *     closed 持倉不觸發
 *     confidence < 0.6 不觸發（繼承 deriveStockMentions invariant）
 *     CN 6 碼不誤撞 TW 4 碼
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnalyzedStockMention, DailyAnalysis } from '@/lib/youtube/analysisStorage';
import { buildHoldingAlerts, bareCode } from '@/lib/youtube/holdingAlerts';
import type { PortfolioHolding } from '@/lib/agents/portfolio/types';

const ANALYSIS_DIR = path.join(process.cwd(), 'data', 'youtube', 'analysis');

const VALID_PRIORITIES = new Set(['must_watch', 'skim', 'skip']);
const VALID_STANCES = new Set(['bullish', 'bearish', 'neutral', 'mixed']);
const CODE_RE = /^\d{4,6}[A-Z]*$/;

async function loadAllAnalyses(): Promise<Array<{ file: string; analysis: DailyAnalysis }>> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(ANALYSIS_DIR)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return [];
  }
  const out: Array<{ file: string; analysis: DailyAnalysis }> = [];
  for (const f of files) {
    try {
      out.push({ file: f, analysis: JSON.parse(await fs.readFile(path.join(ANALYSIS_DIR, f), 'utf-8')) });
    } catch { /* 壞檔由其他測試把關 */ }
  }
  return out;
}

describe('analysis video_summaries 欄位（存在才驗，舊檔無欄位即通過）', () => {
  it('watch_priority / market_stance / 必填欄位 / key_stocks code 合法', async () => {
    const all = await loadAllAnalyses();
    const errors: string[] = [];

    for (const { file, analysis } of all) {
      for (const v of analysis.video_summaries ?? []) {
        const tag = `${file} ${v.video_id}`;
        if (!VALID_PRIORITIES.has(v.watch_priority)) {
          errors.push(`${tag}: 非法 watch_priority=${v.watch_priority}`);
        }
        if (v.market_stance !== undefined && !VALID_STANCES.has(v.market_stance)) {
          errors.push(`${tag}: 非法 market_stance=${v.market_stance}`);
        }
        for (const key of ['video_id', 'source_id', 'source_name', 'title', 'summary', 'watch_reason'] as const) {
          if (typeof v[key] !== 'string' || v[key].trim().length === 0) {
            errors.push(`${tag}: ${key} 必須為非空字串`);
          }
        }
        if (typeof v.summary === 'string' && v.summary.trim().length > 0 && v.summary.trim().length < 20) {
          errors.push(`${tag}: summary 太短（${v.summary.trim().length} 字 < 20）— 疑似改寫標題充數`);
        }
        if (!Array.isArray(v.key_stocks)) {
          errors.push(`${tag}: key_stocks 必須為陣列`);
        } else {
          for (const s of v.key_stocks) {
            if (!CODE_RE.test(s.code)) errors.push(`${tag}: 非法 key_stocks code=${s.code}`);
            if (typeof s.name !== 'string' || s.name.trim().length === 0) {
              errors.push(`${tag}: key_stocks ${s.code} 缺 name`);
            }
          }
        }
      }
    }

    expect(errors).toEqual([]);
  });
});

// ── buildHoldingAlerts 純函式 ─────────────────────────────────────────────────

function m(over: Partial<AnalyzedStockMention>): AnalyzedStockMention {
  return {
    raw_query: '力積電',
    matched: { code: '6770', name: '力積電', market: 'TWSE', confidence: 1, match_via: 'code' },
    llm_confidence: 0.9,
    combined_confidence: 0.9,
    sentiment: 'risk_warning',
    context: '漲多注意風險',
    reason: '乖離過大',
    source_id: 'src-a',
    video_id: 'vid-1',
    ...over,
  } as AnalyzedStockMention;
}

function fakeAnalysis(mentions: AnalyzedStockMention[]): DailyAnalysis {
  return {
    date: '2026-07-01',
    generated_at: '2026-07-01T15:00:00Z',
    market_view: '',
    bullish_consensus: [],
    bearish_consensus: [],
    high_consensus_stocks: mentions,
    weak_signal_stocks: [],
    stats: {
      videos_analyzed: 1,
      unique_stocks_total: mentions.length,
      high_consensus_count: mentions.length,
      weak_signal_count: 0,
    },
  };
}

function holding(over: Partial<PortfolioHolding>): PortfolioHolding {
  return {
    schemaVersion: 1,
    symbol: '6770.TW',
    name: '力積電',
    market: 'TW',
    entryDate: '2026-06-01',
    entryPrice: 25,
    shares: 10,
    status: 'open',
    ...over,
  } as PortfolioHolding;
}

const nameOf = (id: string) => `節目${id}`;

describe('buildHoldingAlerts', () => {
  it('後綴剝除 join："6770.TW" 持倉命中 mention code "6770"', () => {
    const alerts = buildHoldingAlerts(fakeAnalysis([m({})]), [holding({})], nameOf);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].code).toBe('6770');
    expect(alerts[0].symbol).toBe('6770.TW');
    expect(alerts[0].mentions[0].source_name).toBe('節目src-a');
    expect(alerts[0].bearish_count).toBe(1); // risk_warning 計入 bearish
  });

  it('closed 持倉不觸發（過濾收在函式內）', () => {
    const alerts = buildHoldingAlerts(fakeAnalysis([m({})]), [holding({ status: 'closed' })], nameOf);
    expect(alerts).toEqual([]);
  });

  it('combined_confidence < 0.6 不觸發（繼承 deriveStockMentions invariant）', () => {
    const alerts = buildHoldingAlerts(
      fakeAnalysis([m({ combined_confidence: 0.5 })]),
      [holding({})],
      nameOf,
    );
    expect(alerts).toEqual([]);
  });

  it('matched=null 不觸發', () => {
    const alerts = buildHoldingAlerts(fakeAnalysis([m({ matched: null })]), [holding({})], nameOf);
    expect(alerts).toEqual([]);
  });

  it('CN 6 碼持倉不誤撞 TW 4 碼 mention', () => {
    const cn = holding({ symbol: '000988.SZ', name: '华工科技', market: 'CN' });
    const alerts = buildHoldingAlerts(fakeAnalysis([m({})]), [cn], nameOf);
    expect(alerts).toEqual([]);
  });

  it('bareCode 剝後綴、裸碼原樣', () => {
    expect(bareCode('6770.TW')).toBe('6770');
    expect(bareCode('3081.TWO')).toBe('3081');
    expect(bareCode('000988.SZ')).toBe('000988');
    expect(bareCode('2330')).toBe('2330');
  });
});
