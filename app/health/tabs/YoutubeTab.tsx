'use client';

/**
 * /health → YouTube tab
 *
 * Stage 3 把 /youtube 主頁的「資料抓取狀態」搬過來：
 *   - 總體紅綠燈卡
 *   - 6 來源卡 grid
 *   - 影片列表表格
 *   - Audit 面板
 *
 * /youtube 主頁保留「跨節目共識 + 提及股票表」（內容分析），不再雙頭擁有 health 顯示。
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  YouTubeHealthSnapshot,
  YouTubeSourceHealth,
  YouTubeVideo,
} from '@/lib/youtube/types';
import { YoutubeProgramStocks } from '@/components/youtube/YoutubeProgramStocks';
import { VideoSourceBreakdown } from '@/components/youtube/VideoSourceBreakdown';

type LightLevel = 'green' | 'yellow' | 'red' | 'gray';
type FetchStatus = 'fetched' | 'no_new' | 'failed' | 'pending' | 'stale';
type TranscriptStatus = 'available' | 'low_quality' | 'unavailable' | 'failed' | 'pending';

interface HealthResponse {
  ok: boolean;
  snapshot: YouTubeHealthSnapshot | null;
  lights?: Array<{ source_id: string; light: LightLevel; status: FetchStatus; statusLabel: string }>;
  overall?: LightLevel;
  message?: string;
  /** 關鍵幀管線狀態（只列 keyframe_enabled 來源；今日） */
  keyframes?: Array<{
    source_id: string; enabled: boolean;
    analyzable: number; done: number; failed: number; frames_kept: number;
  }>;
}

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

export function YoutubeTab() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [videos, setVideos] = useState<VideoWithTranscript[]>([]);
  const [date, setDate] = useState(todayYmd);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [h, v] = await Promise.all([
          fetch('/api/youtube/health').then(r => r.json()),
          fetch(`/api/youtube/videos?date=${date}`).then(r => r.json()),
        ]);
        if (h.ok) setHealth(h as HealthResponse);
        const vr = v as VideosResponse;
        if (vr.ok) setVideos(vr.videos);
      } catch (err) {
        console.error('[/health > YouTube] fetch failed', err);
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
    const t = setInterval(fetchAll, 60_000);
    return () => clearInterval(t);
  }, [date]);

  const overall: LightLevel = health?.overall ?? 'red';
  const lightConfig: Record<LightLevel, { bg: string; text: string; emoji: string; label: string; tip: string }> = {
    green: {
      bg: 'bg-green-950/60 border-green-700',
      text: 'text-green-300',
      emoji: '✓',
      label: '已抓到當日新節目',
      tip: '至少一個來源今天有抓到並寫入新節目影片(analyzable > 0)。',
    },
    yellow: {
      bg: 'bg-yellow-950/60 border-yellow-700',
      text: 'text-yellow-300',
      emoji: '!',
      label: '部分來源連續空日警告',
      tip: 'IRREGULAR 來源連續多日無新節目,可能漏抓 — 請看下方卡片。',
    },
    red: {
      bg: 'bg-red-950/60 border-red-700',
      text: 'text-red-300',
      emoji: '✗',
      label: '需要處理',
      tip: 'DAILY 來源連續 4 日無新節目 或 抓取失敗 — 可能 yt-dlp 失效或頻道改名。',
    },
    gray: {
      bg: 'bg-slate-800/60 border-slate-600',
      text: 'text-slate-400',
      emoji: '—',
      label: '今日尚未有新節目',
      tip: '掃了 playlist 但今日沒新節目(IRREGULAR 節目常見)或排程還沒跑。屬於正常,非錯誤。',
    },
  };
  const cfg = lightConfig[overall];

  const lightMap = useMemo(() => {
    const m = new Map<string, { light: LightLevel; status: FetchStatus; statusLabel: string }>();
    health?.lights?.forEach(l => m.set(l.source_id, { light: l.light, status: l.status, statusLabel: l.statusLabel }));
    return m;
  }, [health]);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* 日期切換 */}
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground">影片表日期</span>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="px-2 py-1 rounded bg-card border border-border text-foreground"
        />
        <button
          onClick={() => setDate(todayYmd())}
          className="text-blue-400 hover:underline"
        >
          回今天
        </button>
      </div>

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
          {health.snapshot.sources.filter(s => s.active !== false).map(s => {
            const info = lightMap.get(s.source_id);
            return (
              <SourceCard
                key={s.source_id}
                health={s}
                light={info?.light ?? 'gray'}
                fetchStatus={info?.status ?? 'pending'}
                fetchStatusLabel={info?.statusLabel ?? '○ 尚未掃描'}
              />
            );
          })}
        </div>
      )}

      {/* 關鍵幀管線狀態（簡報截圖 OCR；只列 keyframe_enabled 來源，今日） */}
      {health?.keyframes && health.keyframes.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold">🖼 簡報關鍵幀（今日）</h2>
            <span className="text-[11px] text-muted-foreground">
              影片下載 → 場景偵測 → OCR 初篩；OCR 文字進每晚分析 payload
            </span>
          </div>
          <div className="flex gap-3 flex-wrap text-[11px]">
            {health.keyframes.map(k => {
              const sourceName = health.snapshot?.sources.find(s => s.source_id === k.source_id)?.display_name ?? k.source_id;
              return (
                <span key={k.source_id} className="whitespace-nowrap">
                  <span className="text-foreground/80">{sourceName}</span>{' '}
                  <span className={k.failed > 0 ? 'text-red-400' : k.done >= k.analyzable && k.analyzable > 0 ? 'text-green-400' : 'text-muted-foreground'}>
                    {k.done}/{k.analyzable}
                  </span>
                  {k.frames_kept > 0 && <span className="text-sky-400 ml-1">{k.frames_kept} 幀</span>}
                  {k.failed > 0 && <span className="text-red-400 ml-1">⚠{k.failed}</span>}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* 語音 vs 畫面 — 各影片抓到哪些股票（凸顯關鍵幀 OCR 的獨家貢獻）*/}
      <VideoSourceBreakdown date={date} />

      {/* 各節目談了哪些股票（以節目為主軸，反轉 /api/youtube/performance）*/}
      <YoutubeProgramStocks date={date} />

      {/* 跨日老師績效 → 獨立頁（30/60/90 天勝率/平均報酬/超額排行） */}
      <div className="flex justify-end">
        <a href="/youtube/teachers" className="text-xs text-sky-400 hover:underline">
          🎓 老師推薦績效排行榜（誰講的準）→
        </a>
      </div>

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

      {/* Audit 面板 */}
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
  );
}

function SourceCard({ health, light, fetchStatus, fetchStatusLabel }: {
  health: YouTubeSourceHealth;
  light: LightLevel;
  fetchStatus: FetchStatus;
  fetchStatusLabel: string;
}) {
  const dotCls: Record<LightLevel, string> = {
    green: 'bg-green-500',
    yellow: 'bg-yellow-500',
    red: 'bg-red-500',
    gray: 'bg-slate-500',
  };
  const statusTextCls: Record<FetchStatus, string> = {
    fetched: 'text-green-300',
    no_new:  'text-slate-400',
    failed:  'text-red-300',
    pending: 'text-slate-400',
    stale:   'text-yellow-300',
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

      {/* 抓取狀態 — 5 級明確區分:已抓到 / 無新 / 失敗 / 未跑 / 連續空日 */}
      <div
        className={`text-xs font-medium ${statusTextCls[fetchStatus]}`}
        title="2026-05-25 修:狀態以「實際當日 program_date 新節目」為準,playlist 撈到歷史影片不算「抓到」"
      >
        {fetchStatusLabel}
        {fetchStatus === 'fetched' && health.today.analyzable > 0 && (
          <span className="text-muted-foreground"> · {health.today.analyzable} 支</span>
        )}
      </div>

      <div className="text-xs space-y-0.5">
        <KV label="最後掃描" value={fmtTime(health.last_scan_at)} />
        <KV label="最後成功(scan run)" value={fmtTime(health.last_success_at)} />
        {/* 2026-05-25 修:狀態=no_new 時 stale snapshot 的 last_video_discovered_at 會跟狀態矛盾,藏起來避免誤導 */}
        <KV
          label="最後抓到新節目"
          value={fetchStatus === 'no_new' ? '—' : fmtTime(health.last_video_discovered_at)}
        />
        <KV
          label="連續空日"
          value={`${health.consecutive_empty_days} 日`}
          warn={health.consecutive_empty_days >= 2}
        />
        {health.possible_missing_update && (
          <KV label="警告" value="可能漏抓" warn />
        )}
        {/* 只顯示「真正讓掃描失敗」的錯誤；個別影片被刪除/設私人是 playlist 常態 */}
        {health.today.error && health.today.scanned === 0 && (
          <KV label="今日錯誤" value={health.today.error.slice(0, 80)} warn />
        )}
      </div>

      <div className="flex items-center gap-2 text-xs border-t border-border pt-2">
        <Stat
          label="playlist"
          value={health.today.scanned}
          tooltip="yt-dlp 從該節目 playlist 抓到的影片總數(含歷史)。playlist 一次最多抓 30 個,其中大部分通常是舊節目。"
        />
        <Stat
          label="今日新節目"
          value={health.today.analyzable}
          accent
          tooltip={`program_date(標題日期)===今日 且通過所有過濾(非 shorts/preview/ad/直播中/太短)的影片數。\n\n例:可分析=0 ≠ 系統漏抓,通常是該節目今天還沒發新影片,或新影片標題沒寫日期且 published_at 是隔日(常見於晚間節目隔天 00:xx 才上架)。`}
        />
        <Stat
          label="非當日"
          value={health.today.skipped}
          muted
          tooltip="非今日節目(歷史)/ shorts / preview / ad / 直播進行中 / 太短。屬正常,不代表抓取失敗。"
        />
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

function Stat({ label, value, accent, muted, tooltip }: {
  label: string; value: number; accent?: boolean; muted?: boolean; tooltip?: string;
}) {
  const cls = accent ? 'text-foreground font-semibold' : muted ? 'text-muted-foreground' : 'text-foreground';
  return (
    <div className="flex-1 text-center" title={tooltip}>
      <div className={`text-base tabular-nums ${cls}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
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

function DataHealthPanel() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch('/api/youtube/audit').then(r => r.json()).then(d => setData(d as AuditResponse)).catch(() => {});
  }, []);

  if (!data) {
    return <div className="text-xs text-muted-foreground border-t border-border pt-3">資料健康檢查中…</div>;
  }

  // /api/youtube/audit 可能回 { ok: false, error } 沒 summary;guard 一下避免炸
  if (!data.summary || !data.stats) {
    return <div className="text-xs text-muted-foreground border-t border-border pt-3">資料健康檢查 API 失敗 — 看 console 看 /api/youtube/audit 回什麼</div>;
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
