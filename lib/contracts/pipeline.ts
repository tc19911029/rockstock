/**
 * Pipeline Contracts — Zod 驗證 schema
 *
 * 用於資料邊界驗證，確保各層資料格式一致。
 *
 * ⚠️  不可刪除或修改此檔案（見 CLAUDE.md）
 */

import { z } from 'zod';

// ── Layer 1: 歷史 K 棒 ─────────────────────────────────────────────────────

export const CandleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  volume: z.number().min(0),
}).refine(c => c.high >= c.low, { message: 'high must >= low' });

export const CandleFileSchema = z.object({
  symbol: z.string().min(1),
  lastDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  updatedAt: z.string(),
  candles: z.array(CandleSchema).min(1),
});

// ── Layer 2: 盤中快照 ─────────────────────────────────────────────────────

export const IntradayQuoteSchema = z.object({
  symbol: z.string().min(1),
  name: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number().positive(),
  volume: z.number().min(0),
  prevClose: z.number().min(0),
  changePercent: z.number(),
});

export const IntradaySnapshotSchema = z.object({
  market: z.enum(['TW', 'CN']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  updatedAt: z.string(),
  count: z.number().min(0),
  quotes: z.array(IntradayQuoteSchema),
});

// ── Layer 4: 掃描結果 ─────────────────────────────────────────────────────

export const ScanResultSchema = z.object({
  symbol: z.string().min(1),
  name: z.string(),
  market: z.enum(['TW', 'CN']),
  price: z.number(),
  changePercent: z.number(),
  volume: z.number(),
  sixConditionsScore: z.number().min(0).max(6),
  trendState: z.enum(['多頭', '空頭', '盤整']),
  scanTime: z.string(),
});

export const ScanSessionKeySchema = z.object({
  market: z.enum(['TW', 'CN']),
  direction: z.enum(['long', 'short', 'daban']),
  mtfMode: z.enum(['daily', 'mtf']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sessionType: z.enum(['intraday', 'post_close']),
});

// ── 粗掃候選 ─────────────────────────────────────────────────────────────

export const CoarseCandidateSchema = z.object({
  symbol: z.string().min(1),
  name: z.string(),
  market: z.enum(['TW', 'CN']),
  close: z.number().positive(),
  changePercent: z.number(),
  volume: z.number().min(0),
  ma5: z.number(),
  ma10: z.number(),
  ma20: z.number(),
  volumeRatio: z.number().min(0),
  coarseScore: z.number().min(0),
  coarseReasons: z.array(z.string()),
});
