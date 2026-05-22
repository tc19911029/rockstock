'use client';

/**
 * YouTube 理財節目追蹤 — MVP 1 (抓得穩)
 *
 * 顯示：
 *   1. 整體紅綠燈
 *   2. 6 個來源卡 (每張獨立紅綠燈 + 今日 scanned/analyzable/skipped)
 *   3. 今日影片表 (可改日期查歷史)
 *
 * 60 秒 auto-refresh — mirror /app/health/page.tsx 慣例。
 */

import { useEffect, useMemo, useState, Fragment } from 'react';
import { PageShell } from '@/components/shared';
import { YoutubeHeader } from '@/components/youtube/YoutubeHeader';
import type {
  YouTubeHealthSnapshot,
  YouTubeSourceHealth,
  YouTubeVideo,
} from '@/lib/youtube/types';
import type {
  DailyAnalysis,
  DailyStockMention,
  DailyStockMentions,
} from '@/lib/youtube/analysisStorage';

type LightLevel = 'green' | 'yellow' | 'red';

interface HealthResponse {
  ok: boolean;
  snapshot: YouTubeHealthSnapshot | null;
  lights?: Array<{ source_id: string; light: LightLevel }>;
  overall?: LightLevel;
  message?: string;
}

type TranscriptStatus = 'available' | 'low_quality' | 'unavailable' | 'failed' | 'pending';

interface VideoWithTranscript extends YouTubeVideo {
  transcript_status: TranscriptStatus;
  transcript_quality_score: number | null;
  transcript_lang: string | null;
  transcript_char_count: number | null;
}

interface VideosResponse {
  ok: boolean;
  date: string;
  count: number;
  videos: VideoWithTranscript[];
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
  } catch { return '—'; }
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function todayYmd(): string {
  const tpe = new Date(Date.now() + 8 * 3600_000);
  return tpe.toISOString().slice(0, 10);
}

function initialDate(): string {
  if (typeof window === 'undefined') return todayYmd();
  const sp = new URLSearchParams(window.location.search);
  const q = sp.get('date');
  return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayYmd();
}

export default function YouTubePage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [videos, setVideos] = useState<VideoWithTranscript[]>([]);
  const [stocks, setStocks] = useState<DailyStockMentions | null>(null);
  const [analysis, setAnalysis] = useState<DailyAnalysis | null>(null);
  const [date, setDate] = useState(initialDate);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const fetchAll = async () => {
    try {
      const [h, v, s, a] = await Promise.all([
        fetch('/api/youtube/health').then(r => r.json()),
        fetch(`/api/youtube/videos?date=${date}`).then(r => r.json()),
        fetch(`/api/youtube/stocks?date=${date}`).then(r => r.json()),
        fetch(`/api/youtube/analysis/${date}`).then(r => r.json()),
      ]);
      if (h.ok) setHealth(h as HealthResponse);
      const vr = v as VideosResponse;
      if (vr.ok) setVideos(vr.videos);
      if (s.ok) setStocks(s as DailyStockMentions);
      if (a.ok) setAnalysis(a.analysis as DailyAnalysis | null);
      setRefreshedAt(new Date());
    } catch (err) {
      console.error('[/youtube] fetch failed', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (date === todayYmd()) sp.delete('date');
    else sp.set('date', date);
    const qs = sp.toString();
    const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [date]);

  const overall: LightLevel = health?.overall ?? 'red';
  const lightConfig: Record<LightLevel, { bg: string; text: string; emoji: string; label: string; tip: string }> = {
    green: {
      bg: 'bg-green-950/60 border-green-700',
      text: 'text-green-300',
      emoji: '✓',
      label: '抓取正常',
      tip: '所有來源近期都有掃到影片，無錯誤。',
    },
    yellow: {
      bg: 'bg-yellow-950/60 border-yellow-700',
      text: 'text-yellow-300',
      emoji: '!',
      label: '部分來源異常',
      tip: '有來源今日未抓到影片或連續空檔，可能漏抓 — 請看下方卡片。',
    },
    red: {
      bg: 'bg-red-950/60 border-red-700',
      text: 'text-red-300',
      emoji: '✗',
      label: '需要處理',
      tip: '至少一個來源掃描失敗或長期空檔，可能 yt-dlp 失效或頻道改名。',
    },
  };
  const cfg = lightConfig[overall];

  const lightMap = useMemo(() => {
    const m = new Map<string, LightLevel>();
    health?.lights?.forEach(l => m.set(l.source_id, l.light));
    return m;
  }, [health]);

  return (
    <PageShell>
      <div className="max-w-6xl mx-auto p-4 space-y-6">
        <YoutubeHeader
          title="YouTube 理財節目追蹤"
          date={date}
          onDateChange={setDate}
          showExportButton
          rightExtra={
            <span className="text-muted-foreground">
              {refreshedAt ? `更新於 ${fmtTime(refreshedAt.toISOString())}` : '載入中…'}
            </span>
          }
        />

        {/* 總體紅綠燈 */}
        <div className={`rounded-lg border p-6 ${cfg.bg}`}>
          <div className="flex items-center gap-4">
            <div className={`text-5xl font-bold ${cfg.text}`}>{cfg.emoji}</div>
            <div className="flex-1">
              <div className={`text-2xl font-semibold ${cfg.text}`}>{cfg.label}</div>
              <div className="text-sm text-muted-foreground mt-1">{cfg.tip}</div>
            </div>
          </div>
        </div>

        {loading && !health && (
          <div className="text-center py-12 text-muted-foreground">載入中…</div>
        )}

        {health && !health.snapshot && (
          <div className="rounded border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            {health.message ?? '尚未有掃描紀錄，請先觸發一次 cron。'}
          </div>
        )}

        {/* 來源卡（archived 來源不顯示） */}
        {health?.snapshot && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {health.snapshot.sources.filter(s => s.active !== false).map(s => (
              <SourceCard
                key={s.source_id}
                health={s}
                light={lightMap.get(s.source_id) ?? 'yellow'}
              />
            ))}
          </div>
        )}

        {/* Claude 跨節目分析（大盤共識） */}
        {analysis && (
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            {analysis.is_placeholder && (
              <div className="rounded border border-yellow-700 bg-yellow-900/30 px-3 py-2 text-xs text-yellow-200">
                ⚠ <strong>這份 analysis 是手動填的示範資料</strong>，不是真實 /youtube-analysis skill 跑出來的。
                等今晚 transcript 全跑完後，請開新對話打 <code className="text-yellow-100">/youtube-analysis</code> 寫真實版覆蓋。
              </div>
            )}
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">
                今日跨節目共識（Claude 分析）
                {analysis.is_placeholder && (
                  <span className="ml-2 text-xs font-normal text-yellow-400">[placeholder]</span>
                )}
              </h2>
              <span className="text-xs text-muted-foreground">
                {fmtTime(analysis.generated_at)} 寫入
              </span>
            </div>
            <div className="text-sm whitespace-pre-wrap leading-relaxed">{analysis.market_view}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-green-400 font-medium mb-1">看多共識</div>
                {analysis.bullish_consensus.length === 0
                  ? <div className="text-muted-foreground">—</div>
                  : <ul className="list-disc list-inside text-foreground space-y-0.5">
                      {analysis.bullish_consensus.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                }
              </div>
              <div>
                <div className="text-red-400 font-medium mb-1">風險提醒</div>
                {analysis.bearish_consensus.length === 0
                  ? <div className="text-muted-foreground">—</div>
                  : <ul className="list-disc list-inside text-foreground space-y-0.5">
                      {analysis.bearish_consensus.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                }
              </div>
            </div>
            <div className="text-[11px] text-muted-foreground border-t border-border pt-2">
              分析了 {analysis.stats.videos_analyzed} 支影片 · 高共識股 {analysis.stats.high_consensus_count} · 弱信號股 {analysis.stats.weak_signal_count}
            </div>
          </div>
        )}

        {!analysis && stocks && stocks.total_unique_stocks === 0 && health?.snapshot && (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            還沒分析過今日內容。執行流程：
            <ol className="list-decimal list-inside mt-2 space-y-1 text-xs">
              <li>scan/transcript cron 跑完後（22:30 CST / 09:30 CST 後）</li>
              <li>跑 <code className="text-foreground">curl -H &quot;Authorization: Bearer $CRON_SECRET&quot; -X POST localhost:3000/api/cron/youtube-prepare-analysis</code></li>
              <li>開 Claude Code 對話輸入 <code className="text-foreground">/youtube-analysis</code> skill</li>
              <li>Claude 寫完 <code className="text-foreground">data/youtube/analysis/{date}.json</code> 後此區會顯示</li>
            </ol>
          </div>
        )}

        {/* 今日股票彙整 */}
        {stocks && stocks.total_unique_stocks > 0 && (
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-lg font-semibold">今日提到的股票 ({stocks.total_unique_stocks})</h2>
              <div className="text-xs text-muted-foreground">
                來自 {stocks.total_videos_processed} 支影片 · 已過濾低信心匹配
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b border-border">
                  <tr className="text-left">
                    <th className="py-2 pr-1 w-4"></th>
                    <th className="py-2 pr-2 whitespace-nowrap">代號</th>
                    <th className="py-2 pr-2 whitespace-nowrap">名稱</th>
                    <th className="py-2 pr-2 text-center">評級</th>
                    <th className="py-2 pr-2 text-right">總分</th>
                    <th className="py-2 pr-2 text-right">提及次數</th>
                    <th className="py-2 pr-2 text-right">看多</th>
                    <th className="py-2 pr-2 text-right">看空</th>
                    <th className="py-2 pr-2 text-right">信心</th>
                    <th className="py-2 pr-2">節目情緒</th>
                    <th className="py-2 pr-2">建議</th>
                  </tr>
                </thead>
                <tbody>
                  {stocks.stocks.map(s => (
                    <StockMentionRow key={s.stock_code} m={s} />
                  ))}
                </tbody>
              </table>
              <div className="text-[10px] text-muted-foreground mt-2 pl-1">
                點任一列展開該股所有節目提及的原話片段
              </div>
            </div>
          </div>
        )}

        {/* 影片表 */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-lg font-semibold">影片列表</h2>
            <span className="text-xs text-muted-foreground">共 {videos.length} 支</span>
          </div>

          {videos.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              該日無資料 — cron 尚未跑或當日無新影片。
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b border-border">
                  <tr className="text-left">
                    <th className="py-2 pr-2">來源</th>
                    <th className="py-2 pr-2">標題</th>
                    <th className="py-2 pr-2 whitespace-nowrap">時長</th>
                    <th className="py-2 pr-2">類型</th>
                    <th className="py-2 pr-2 whitespace-nowrap">節目日</th>
                    <th className="py-2 pr-2">分析?</th>
                    <th className="py-2 pr-2">跳過原因</th>
                    <th className="py-2 pr-2 text-right">信心</th>
                    <th className="py-2 pr-2">逐字稿</th>
                    <th className="py-2 pr-2 text-right">稿品質</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map(v => (
                    <tr key={v.video_id} className="border-b border-border/40 hover:bg-muted/30">
                      <td className="py-2 pr-2 whitespace-nowrap text-muted-foreground">{v.source_id}</td>
                      <td className="py-2 pr-2 max-w-md truncate">
                        <a href={v.url} target="_blank" rel="noreferrer" className="hover:underline text-foreground">
                          {v.title}
                        </a>
                      </td>
                      <td className="py-2 pr-2 whitespace-nowrap text-muted-foreground">{fmtDuration(v.duration_sec)}</td>
                      <td className="py-2 pr-2 whitespace-nowrap"><VideoTypeBadge type={v.video_type} /></td>
                      <td className="py-2 pr-2 whitespace-nowrap text-muted-foreground">{v.program_date ?? '—'}</td>
                      <td className="py-2 pr-2">{v.should_analyze ? '✓' : '✗'}</td>
                      <td className="py-2 pr-2 text-muted-foreground">{v.skip_reason ?? '—'}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{v.video_confidence_score}</td>
                      <td className="py-2 pr-2 whitespace-nowrap"><TranscriptBadge status={v.transcript_status} /></td>
                      <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                        {v.transcript_quality_score ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 資料健康（audit） */}
        <DataHealthPanel />

        {/* 操作提示 */}
        <div className="text-xs text-muted-foreground border-t border-border pt-3">
          <div className="font-medium mb-1">看到紅燈/黃燈怎麼辦？</div>
          <ul className="list-disc list-inside space-y-0.5 pl-2">
            <li>單來源黃燈：cron 下一輪 (19:00 / 23:35 CST) 會重試</li>
            <li>單來源紅燈：手動跑 <code className="text-foreground">curl -H &quot;Authorization: Bearer $CRON_SECRET&quot; &apos;http://localhost:3000/api/cron/youtube-scan?source_id=...&apos;</code></li>
            <li>連續空檔 ≥4 天 (daily 來源)：可能 yt-dlp 失效或頻道改名 — 檢查 url 是否仍有效</li>
            <li>調整來源：直接編輯 <code className="text-foreground">data/youtube/sources.json</code> 或 PATCH /api/youtube/sources</li>
          </ul>
        </div>
      </div>
    </PageShell>
  );
}

function SourceCard({ health, light }: { health: YouTubeSourceHealth; light: LightLevel }) {
  const dotCls: Record<LightLevel, string> = {
    green: 'bg-green-500',
    yellow: 'bg-yellow-500',
    red: 'bg-red-500',
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${dotCls[light]}`} />
          <span className="font-semibold">{health.display_name}</span>
        </div>
        <span className="text-[10px] uppercase text-muted-foreground tracking-wider">
          {health.expected_cadence}
        </span>
      </div>

      <div className="text-xs space-y-0.5">
        <KV label="最後掃描" value={fmtTime(health.last_scan_at)} />
        <KV label="最後成功" value={fmtTime(health.last_success_at)} />
        <KV label="最後抓到影片" value={fmtTime(health.last_video_discovered_at)} />
        <KV
          label="連續空日"
          value={`${health.consecutive_empty_days} 日`}
          warn={health.consecutive_empty_days >= 2}
        />
        {health.possible_missing_update && (
          <KV label="警告" value="可能漏抓" warn />
        )}
        {/* 只顯示「真正讓掃描失敗」的錯誤；個別影片被刪除/設私人是 playlist 常態，不該嚇人 */}
        {health.today.error && health.today.scanned === 0 && (
          <KV label="今日錯誤" value={health.today.error.slice(0, 80)} warn />
        )}
      </div>

      <div className="flex items-center gap-2 text-xs border-t border-border pt-2">
        <Stat label="掃描" value={health.today.scanned} />
        <Stat label="可分析" value={health.today.analyzable} accent />
        <Stat label="跳過" value={health.today.skipped} muted />
      </div>
    </div>
  );
}

function KV({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={warn ? 'text-yellow-400' : 'text-foreground'}>{value}</span>
    </div>
  );
}

function Stat({ label, value, accent, muted }: {
  label: string; value: number; accent?: boolean; muted?: boolean;
}) {
  const cls = accent ? 'text-foreground font-semibold' : muted ? 'text-muted-foreground' : 'text-foreground';
  return (
    <div className="flex-1 text-center">
      <div className={`text-base tabular-nums ${cls}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

const SENTIMENT_LABEL: Record<string, { text: string; cls: string }> = {
  bullish:        { text: '看多',    cls: 'text-green-400' },
  bearish:        { text: '看空',    cls: 'text-red-400' },
  watchlist:      { text: '觀察',    cls: 'text-yellow-400' },
  risk_warning:   { text: '風險',    cls: 'text-orange-400' },
  neutral:        { text: '中立',    cls: 'text-muted-foreground' },
  mentioned_only: { text: '提及',    cls: 'text-muted-foreground' },
};

function StockMentionRow({ m }: { m: DailyStockMention }) {
  const [open, setOpen] = useState(false);
  const sentiments = m.mentioned_in.map(v => v.sentiment);
  const sentimentLabel = (() => {
    if (m.bullish_count > m.bearish_count) return '看多';
    if (m.bearish_count > m.bullish_count) return '看空';
    if (sentiments.some(s => s === 'watchlist')) return '觀察';
    return '提及';
  })();
  const cls =
    sentimentLabel === '看多' ? 'text-green-400'
    : sentimentLabel === '看空' ? 'text-red-400'
    : 'text-muted-foreground';
  const topMention = [...m.mentioned_in].sort((a,b) => b.combined_confidence - a.combined_confidence)[0];
  return (
    <Fragment>
      <tr
        className="border-b border-border/40 hover:bg-muted/30 cursor-pointer"
        onClick={() => setOpen(v => !v)}
      >
        <td className="py-2 pr-1 text-center text-muted-foreground select-none">
          {open ? '▾' : '▸'}
        </td>
        <td className="py-2 pr-2 tabular-nums">{m.stock_code}</td>
        <td className="py-2 pr-2 font-medium">{m.stock_name}</td>
        <td className="py-2 pr-2 text-center">
          {m.scoring ? <RatingBadge rating={m.scoring.rating} /> : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
          {m.scoring ? m.scoring.composite_score.toFixed(1) : '—'}
        </td>
        <td className="py-2 pr-2 text-right tabular-nums">{m.mention_count}</td>
        <td className="py-2 pr-2 text-right tabular-nums text-green-400">{m.bullish_count || ''}</td>
        <td className="py-2 pr-2 text-right tabular-nums text-red-400">{m.bearish_count || ''}</td>
        <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">{m.best_confidence.toFixed(2)}</td>
        <td className={`py-2 pr-2 ${cls}`}>{sentimentLabel}</td>
        <td className="py-2 pr-2 text-muted-foreground max-w-md truncate">
          {m.scoring?.action ?? topMention?.reason ?? '—'}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/40 bg-muted/20">
          <td colSpan={11} className="px-4 py-3">
            {m.scoring && (
              <div className="mb-4 p-3 rounded border border-border bg-card">
                <div className="flex items-center gap-3 mb-2">
                  <RatingBadge rating={m.scoring.rating} />
                  <span className="text-sm font-medium">總分 {m.scoring.composite_score.toFixed(1)}</span>
                  <span className="text-xs text-muted-foreground">· {m.scoring.action}</span>
                </div>
                <div className="grid grid-cols-3 md:grid-cols-9 gap-2 text-[11px] mb-2">
                  <FactorChip label="技術 25" v={m.scoring.factor_scores.technical} />
                  <FactorChip label="籌碼 18" v={m.scoring.factor_scores.chip} />
                  <FactorChip label="基本面 15" v={m.scoring.factor_scores.fundamental} />
                  <FactorChip label="消息 12" v={m.scoring.factor_scores.news} />
                  <FactorChip label="熱度 10" v={m.scoring.factor_scores.mention_heat} />
                  <FactorChip label="產業 10" v={m.scoring.factor_scores.industry} />
                  <FactorChip label="大盤 5" v={m.scoring.factor_scores.macro} />
                  <FactorChip label="估值 3" v={m.scoring.factor_scores.valuation} />
                  <FactorChip label="治理 2" v={m.scoring.factor_scores.governance} />
                </div>
                <div className="text-[11px] text-muted-foreground">{m.scoring.reasoning}</div>
                {m.scoring.risk_flags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {m.scoring.risk_flags.map((rf, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded border border-red-700 bg-red-900/30 text-red-300 text-[10px]">
                        {rf}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="space-y-2">
              {m.mentioned_in.map((entry, idx) => {
                const sent = SENTIMENT_LABEL[entry.sentiment] ?? SENTIMENT_LABEL.mentioned_only;
                return (
                  <div key={idx} className="text-[11px] border-l-2 border-border pl-3 py-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`font-semibold ${sent.cls}`}>{sent.text}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">{entry.source_id}</span>
                      <span className="text-muted-foreground">·</span>
                      <a
                        href={`https://www.youtube.com/watch?v=${entry.video_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-400 hover:underline"
                        onClick={e => e.stopPropagation()}
                      >
                        {entry.video_id} ↗
                      </a>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground tabular-nums">信心 {entry.combined_confidence.toFixed(2)}</span>
                    </div>
                    <div className="text-foreground">
                      <span className="text-muted-foreground">原話：</span>{entry.context || '—'}
                    </div>
                    <div className="text-foreground">
                      <span className="text-muted-foreground">理由：</span>{entry.reason || '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function RatingBadge({ rating }: { rating: 'A' | 'B' | 'C' | 'D' }) {
  const styleMap = {
    A: 'bg-green-900/50 text-green-300 border-green-600',
    B: 'bg-blue-900/40 text-blue-300 border-blue-700',
    C: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    D: 'bg-red-900/40 text-red-300 border-red-700',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded border text-xs font-bold ${styleMap[rating]}`}>
      {rating}
    </span>
  );
}

// ── 資料健康面板（audit endpoint 包裝） ─────────────────────────────

interface AuditIssue {
  severity: 'HIGH' | 'MED' | 'LOW' | 'INFO';
  area: string;
  message: string;
  affected_count?: number;
  sample?: string[];
}

interface AuditResponse {
  ok: boolean;
  generated_at: string;
  issues: AuditIssue[];
  summary: { high: number; med: number; low: number; info: number };
  stats: {
    video_files: number;
    total_videos: number;
    analyzable_videos: number;
    transcript_files: number;
    analyzed_dates: string[];
    active_sources: number;
    placeholder_analyses: string[];
  };
}

function DataHealthPanel() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch('/api/youtube/audit').then(r => r.json()).then(d => setData(d as AuditResponse)).catch(() => {});
  }, []);

  if (!data) {
    return <div className="text-xs text-muted-foreground border-t border-border pt-3">資料健康檢查中…</div>;
  }

  const totalIssues = data.summary.high + data.summary.med + data.summary.low + data.summary.info;
  const sevCls = (s: AuditIssue['severity']) =>
    s === 'HIGH' ? 'text-red-400'
    : s === 'MED' ? 'text-yellow-400'
    : s === 'LOW' ? 'text-blue-400'
    : 'text-muted-foreground';

  const headerCls =
    data.summary.high > 0 ? 'text-red-400'
    : data.summary.med > 0 ? 'text-yellow-400'
    : 'text-green-400';

  return (
    <div className="text-xs border-t border-border pt-3 space-y-2">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex items-center justify-between w-full text-left hover:bg-muted/30 px-2 py-1 rounded"
      >
        <div className="flex items-center gap-3">
          <span className={`font-medium ${headerCls}`}>
            {expanded ? '▾' : '▸'} 資料健康
          </span>
          <span className="text-muted-foreground tabular-nums">
            高 {data.summary.high} · 中 {data.summary.med} · 低 {data.summary.low} · 提示 {data.summary.info}
          </span>
        </div>
        <span className="text-muted-foreground">
          {data.stats.video_files} files · {data.stats.analyzable_videos} 可分析 · {data.stats.transcript_files} transcript
        </span>
      </button>

      {expanded && (
        <div className="pl-4 space-y-2">
          {totalIssues === 0 ? (
            <div className="text-green-400">✓ 沒有發現問題</div>
          ) : (
            data.issues.map((iss, i) => (
              <div key={i} className="border-l-2 border-border pl-3 py-1">
                <div className="flex items-baseline gap-2">
                  <span className={`font-bold ${sevCls(iss.severity)}`}>{iss.severity}</span>
                  <span className="text-muted-foreground">[{iss.area}]</span>
                  {iss.affected_count && <span className="text-muted-foreground">{iss.affected_count} 筆</span>}
                </div>
                <div className="text-foreground/90 mt-0.5">{iss.message}</div>
                {iss.sample && iss.sample.length > 0 && (
                  <ul className="mt-1 text-muted-foreground text-[10px]">
                    {iss.sample.map((s, j) => <li key={j} className="font-mono">· {s}</li>)}
                  </ul>
                )}
              </div>
            ))
          )}
          <div className="text-[10px] text-muted-foreground pt-1">
            最後檢查 {new Date(data.generated_at).toLocaleString('zh-TW', { hour12: false })}
          </div>
        </div>
      )}
    </div>
  );
}

function FactorChip({ label, v }: { label: string; v: number }) {
  const cls =
    v >= 75 ? 'text-green-400' :
    v >= 60 ? 'text-blue-400' :
    v >= 45 ? 'text-yellow-400' :
    'text-red-400';
  return (
    <div className="flex items-center justify-between bg-muted/50 rounded px-2 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${cls}`}>{v.toFixed(0)}</span>
    </div>
  );
}

function TranscriptBadge({ status }: { status: TranscriptStatus }) {
  const styleMap: Record<TranscriptStatus, { cls: string; label: string }> = {
    available:   { cls: 'bg-green-900/40 text-green-300 border-green-700',   label: 'OK' },
    low_quality: { cls: 'bg-yellow-900/40 text-yellow-300 border-yellow-700', label: '低品質' },
    unavailable: { cls: 'bg-muted text-muted-foreground border-border',       label: '無字幕' },
    failed:      { cls: 'bg-red-900/40 text-red-300 border-red-700',          label: '失敗' },
    pending:     { cls: 'bg-blue-900/40 text-blue-300 border-blue-700',       label: '待抓' },
  };
  const s = styleMap[status];
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${s.cls}`}>
      {s.label}
    </span>
  );
}

function VideoTypeBadge({ type }: { type: YouTubeVideo['video_type'] }) {
  const styleMap: Record<YouTubeVideo['video_type'], string> = {
    full_program: 'bg-green-900/40 text-green-300 border-green-700',
    live_replay: 'bg-blue-900/40 text-blue-300 border-blue-700',
    clip: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    shorts: 'bg-purple-900/40 text-purple-300 border-purple-700',
    preview: 'bg-orange-900/40 text-orange-300 border-orange-700',
    ad: 'bg-red-900/40 text-red-300 border-red-700',
    unknown: 'bg-muted text-muted-foreground border-border',
  };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${styleMap[type]}`}>
      {type}
    </span>
  );
}
