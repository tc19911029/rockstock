/**
 * POST /api/cron/youtube-prepare-analysis
 *
 * 整理今日資料寫成 question payload 到 /tmp/rockstock-youtube/{date}-question.json，
 * 讓使用者在 Claude Code 對話 / skill 內讀檔做分析。
 *
 * 取代舊的 youtube-extract（SDK 路線已移除）。
 *
 * Query:
 *   ?date=YYYY-MM-DD     指定日期
 *   ?force=1             忽略「今天已產生過」（其實永遠覆蓋，這旗標只是配對 scan/transcript 慣例）
 */

import { NextRequest } from 'next/server';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { buildQuestion, writeQuestionToTmp, QUESTION_DIR } from '@/lib/youtube/questionBuilder';
import { loadSources, loadVideosForDate } from '@/lib/youtube/videoStorage';
import { loadTranscript, loadTranscriptIndex } from '@/lib/youtube/transcriptStorage';
import { loadStockMaster, lookupStock } from '@/lib/youtube/stockMaster';
import { loadMacro, loadStockBundles } from '@/lib/youtube/stockDataLoader';
import type { TranscriptRecord } from '@/lib/youtube/transcriptStorage';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) { return handle(req); }
export async function GET(req: NextRequest) { return handle(req); }

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayYmdTaipei(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }

  // 1) videos：target_date 的 video 可能存在 target_date 或 target_date+1 的檔
  //    （晚間上傳可能隔日早上的 scan 才發現）。合併載入 + 用 published_at 過濾。
  const videosToday = await loadVideosForDate(date);
  const nextDate = addDays(date, 1);
  const videosNext = await loadVideosForDate(nextDate);
  const allVideos = [...videosToday, ...videosNext];
  // dedup by video_id, preserve first occurrence
  const seenIds = new Set<string>();
  const merged: typeof videosToday = [];
  for (const v of allVideos) {
    if (seenIds.has(v.video_id)) continue;
    seenIds.add(v.video_id);
    merged.push(v);
  }
  // filter by published_at falling in target date (Asia/Taipei)
  const videos = merged.filter(v => {
    if (!v.published_at) return false;
    return ymdTaipei(new Date(v.published_at)) === date;
  });
  const transcriptIndex = await loadTranscriptIndex();
  const transcripts = new Map<string, TranscriptRecord>();
  for (const v of videos) {
    if (!v.should_analyze) continue;
    const idxEntry = transcriptIndex.byId[v.video_id];
    if (!idxEntry || idxEntry.status !== 'available') continue;
    const t = await loadTranscript(idxEntry.date, v.video_id);
    if (t && t.status === 'available') {
      transcripts.set(v.video_id, t);
    }
  }

  // 2) sources
  const sources = (await loadSources()).map(s => ({
    source_id: s.source_id,
    display_name: s.display_name,
    expected_cadence: s.expected_cadence,
  }));

  // 3) master + prelookup (對所有影片標題裡的代號/常見股票名做預先 lookup)
  const master = await loadStockMaster();
  const prelookupNames = collectPrelookupCandidates(videos);
  const prelookups = prelookupNames.map(q => {
    const m = lookupStock(q, master);
    return {
      raw_query: q,
      matched_code: m?.code ?? null,
      matched_name: m?.name ?? null,
      confidence: m?.confidence ?? 0,
    };
  });

  // 4) 抓 6 大面向資料（針對 prelookup 中 matched 的股票）
  //    上限 20 檔，避免 internal API 同時湧入 6×N 個請求
  const codesToFetch = Array.from(new Set(
    prelookups.filter(p => p.matched_code).map(p => p.matched_code!),
  )).slice(0, 20);
  let stockDataBundles: Awaited<ReturnType<typeof loadStockBundles>> = [];
  let macro: Awaited<ReturnType<typeof loadMacro>> | null = null;
  try {
    [stockDataBundles, macro] = await Promise.all([
      loadStockBundles(codesToFetch, 4),
      loadMacro(),
    ]);
  } catch (err) {
    console.error('[youtube-prepare-analysis] enrichment failed', err);
  }

  // 5) build payload
  const payload = buildQuestion({
    date, videos, transcripts, sources, master, prelookups,
    stockDataBundles, macro,
  });

  // 6) write to /tmp
  let questionPath: string | null = null;
  try {
    questionPath = await writeQuestionToTmp(payload);
  } catch (err) {
    return apiError(`writeQuestion failed: ${(err as Error).message}`, 500);
  }

  return apiOk({
    date,
    question_path: questionPath,
    question_dir: QUESTION_DIR,
    output_path: payload.output_path,
    stats: {
      videos_with_transcript: payload.videos_with_transcript,
      total_analyzable_videos: payload.total_analyzable_videos,
      skip_summary: payload.skip_summary,
      source_availability: payload.source_transcript_availability,
      payload_bytes: JSON.stringify(payload).length,
      master_hint_entries: payload.stock_master_hint.length,
      prelookup_entries: payload.prelookup.length,
      stock_data_bundles: payload.stock_data_bundles.length,
      macro_regime: payload.macro?.data?.market_regime ?? 'none',
    },
  });
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function ymdTaipei(d: Date): string {
  const taipei = new Date(d.getTime() + 8 * 3600_000);
  const y = taipei.getUTCFullYear();
  const m = taipei.getUTCMonth() + 1;
  const day = taipei.getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 從影片標題抽出常見股票稱呼字串，供 prelookup */
function collectPrelookupCandidates(videos: import('@/lib/youtube/types').YouTubeVideo[]): string[] {
  const candidates = new Set<string>();
  const codeRe = /\b(\d{4,6})\b/g;
  for (const v of videos) {
    if (!v.should_analyze) continue;
    // 4-6 位數代號（過濾 1900-2099 年份噪音、19xx-20xx 日期前綴）
    let m: RegExpExecArray | null;
    while ((m = codeRe.exec(v.title)) !== null) {
      const n = Number(m[1]);
      // 年份範圍跳過
      if (m[1].length === 4 && n >= 1900 && n <= 2099) continue;
      candidates.add(m[1]);
    }
    // 常見公司名 — 用幾個高頻關鍵字粗略命中
    const keywords = [
      '台積電', '聯發科', '世芯', '創意', '智原', '雙鴻', '奇鋐', '台光電',
      '金像電', '鴻海', '緯穎', '台達電', '中信金', '國泰金', '富邦金', '兆豐金',
      '長榮', '陽明', '大立光', '南亞科', '聯電', '國巨',
    ];
    for (const k of keywords) {
      if (v.title.includes(k)) candidates.add(k);
    }
  }
  return Array.from(candidates).slice(0, 50);
}
