/**
 * CoarseScanner — 第一級全市場粗掃
 *
 * 使用 Layer 2 的全市場快照 + MA Base 進行快速篩選，
 * 不讀逐檔 Blob candle files，確保 < 3 秒完成（含手機網路）。
 *
 * 輸出候選清單交由 MarketScanner 進行第二級精掃。
 *
 * 粗掃只做「快速排除」，寧可多選幾檔（false positive ok），
 * 不可漏掉好股（false negative 不可接受）。
 */

import type { IntradayQuote, IntradaySnapshot, MABaseSnapshot } from '@/lib/datasource/IntradayCache';

// ── Types ───────────────────────────────────────────────────────────────────

export interface CoarseCandidate {
  symbol: string;
  name: string;
  /** 方便精掃時使用 */
  market: 'TW' | 'CN';
  /** 最新價 */
  close: number;
  /** 漲跌幅 % */
  changePercent: number;
  /** 今日成交量 */
  volume: number;
  /** 即時算出的 MA5 */
  ma5: number;
  /** 即時算出的 MA10 */
  ma10: number;
  /** 即時算出的 MA20 */
  ma20: number;
  /** 量比（今日量 / 5日均量） */
  volumeRatio: number;
  /** 粗掃通過的條件數 */
  coarseScore: number;
  /** 粗掃通過的條件明細 */
  coarseReasons: string[];
}

export interface CoarseScanResult {
  market: 'TW' | 'CN';
  date: string;
  total: number;           // 全市場總數
  candidateCount: number;  // 通過粗掃的數量
  candidates: CoarseCandidate[];
  scanTimeMs: number;      // 掃描耗時（毫秒）
  snapshotAge: string;     // 快照距今多久
}

export interface CoarseScanOptions {
  /** 做多/做空（預設做多） */
  direction?: 'long' | 'short';
  /** 最小漲幅門檻 %（做多預設 -2，允許小跌；做空預設 +2，允許小漲） */
  minChangePercent?: number;
  maxChangePercent?: number;
  /** 最低量比（今日量 / 5日均量），預設 0.5 */
  minVolumeRatio?: number;
  /** 最低價格（排除仙股），TW 預設 10，CN 預設 3 */
  minPrice?: number;
  /** 最高價格（排除超高價股），預設 Infinity */
  maxPrice?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeMA(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function computeAvgVolume(volumes: number[], period: number): number {
  if (volumes.length < period) return 0;
  const slice = volumes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ── Main Scanner ────────────────────────────────────────────────────────────

/**
 * 執行全市場粗掃
 *
 * @param snapshot Layer 2 全市場盤中快照
 * @param maBase   MA Base（最近 20 根歷史收盤價 + 成交量）
 * @param options  粗掃選項
 */
export function coarseScan(
  snapshot: IntradaySnapshot,
  maBase: MABaseSnapshot | null,
  options: CoarseScanOptions = {},
): CoarseScanResult {
  const startTime = Date.now();
  const {
    direction = 'long',
    minChangePercent = direction === 'long' ? -2 : undefined,
    maxChangePercent = direction === 'short' ? 2 : undefined,
    minVolumeRatio = 0.5,
    minPrice = snapshot.market === 'TW' ? 10 : 3,
    maxPrice = Infinity,
  } = options;

  const candidates: CoarseCandidate[] = [];
  const maData = maBase?.data ?? {};

  for (const q of snapshot.quotes) {
    const reasons: string[] = [];
    let score = 0;

    // ── 基本過濾 ──
    if (q.close <= 0) continue;
    if (q.close < minPrice || q.close > maxPrice) continue;

    // ── 漲跌幅過濾 ──
    if (minChangePercent !== undefined && q.changePercent < minChangePercent) continue;
    if (maxChangePercent !== undefined && q.changePercent > maxChangePercent) continue;

    // ── 計算即時 MA ──
    const entry = maData[q.symbol];
    const historicalCloses = entry?.closes ?? [];
    const historicalVolumes = entry?.volumes ?? [];

    // 把今日收盤加到歷史尾端，即時算 MA
    const allCloses = [...historicalCloses, q.close];
    const allVolumes = [...historicalVolumes, q.volume];

    const ma5 = computeMA(allCloses, 5);
    const ma10 = computeMA(allCloses, 10);
    const ma20 = computeMA(allCloses, 20);
    const avgVol5 = computeAvgVolume(allVolumes, 5);
    const volumeRatio = avgVol5 > 0 ? q.volume / avgVol5 : 0;

    // ── 量比過濾 ──
    if (volumeRatio < minVolumeRatio && avgVol5 > 0) continue;

    // ── 做多粗篩條件 ──
    if (direction === 'long') {
      // 條件 1: 價格站穩 MA20（或 MA20 無效時跳過此條件）
      if (ma20 > 0 && q.close > ma20) {
        reasons.push('站穩MA20');
        score++;
      }

      // 條件 2: MA5 > MA20（均線向上）
      if (ma5 > 0 && ma20 > 0 && ma5 > ma20) {
        reasons.push('MA5>MA20');
        score++;
      }

      // 條件 3: 有量（量比 > 1 表示放量）
      if (volumeRatio >= 1) {
        reasons.push(`量比${volumeRatio.toFixed(1)}`);
        score++;
      }

      // 條件 4: 今日上漲
      if (q.changePercent > 0) {
        reasons.push(`漲${q.changePercent.toFixed(1)}%`);
        score++;
      }

      // 條件 5: MA 排列多頭（MA5 > MA10 > MA20）
      if (ma5 > 0 && ma10 > 0 && ma20 > 0 && ma5 > ma10 && ma10 > ma20) {
        reasons.push('均線多頭排列');
        score++;
      }

      // 至少 2 個條件通過才納入候選（寧多勿漏）
      if (score < 2) continue;

    } else {
      // ── 做空粗篩條件 ──
      if (ma20 > 0 && q.close < ma20) {
        reasons.push('跌破MA20');
        score++;
      }
      if (ma5 > 0 && ma20 > 0 && ma5 < ma20) {
        reasons.push('MA5<MA20');
        score++;
      }
      if (q.changePercent < 0) {
        reasons.push(`跌${q.changePercent.toFixed(1)}%`);
        score++;
      }
      if (score < 2) continue;
    }

    candidates.push({
      symbol: q.symbol,
      name: q.name,
      market: snapshot.market,
      close: q.close,
      changePercent: q.changePercent,
      volume: q.volume,
      ma5: Math.round(ma5 * 100) / 100,
      ma10: Math.round(ma10 * 100) / 100,
      ma20: Math.round(ma20 * 100) / 100,
      volumeRatio: Math.round(volumeRatio * 100) / 100,
      coarseScore: score,
      coarseReasons: reasons,
    });
  }

  // 按 coarseScore 降序排列
  candidates.sort((a, b) => b.coarseScore - a.coarseScore);

  const scanTimeMs = Date.now() - startTime;
  const snapshotAge = `${Math.round((Date.now() - new Date(snapshot.updatedAt).getTime()) / 1000)}s`;

  return {
    market: snapshot.market,
    date: snapshot.date,
    total: snapshot.count,
    candidateCount: candidates.length,
    candidates,
    scanTimeMs,
    snapshotAge,
  };
}
