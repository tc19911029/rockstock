'use client';

/**
 * YoutubeStockCard — YouTube 提及股票卡片
 *
 * 4 row layout（仿 ScanResultsCompact 但右側上下文是 YouTube 而非掃描）：
 *   Row 1: 代號 + 名稱 + Rating + 看多/看空計數
 *   Row 2: 📺 N 個節目 + 前 3 個 source chips + +N more
 *   Row 3: best-confidence reason（截短）
 *   Row 4: 6 欄 N 日漲跌（隔日開/1/3/5/10/20）— 仿 COMPACT_FWD
 */

import { useState } from 'react';
import type { PerformanceItem } from '@/app/api/youtube/performance/route';

interface Props {
  item: PerformanceItem;
  selected?: boolean;
  onSelect?: (code: string) => void;
}

const RATING_CLASS: Record<string, string> = {
  A: 'bg-green-900/50 text-green-300 border-green-600',
  B: 'bg-blue-900/40 text-blue-300 border-blue-700',
  C: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
  D: 'bg-red-900/40 text-red-300 border-red-700',
};

// 對齊 /youtube 主頁 SENTIMENT_LABEL — 把 LLM 寫的英文 sentiment token 翻成中文
const SENTIMENT_LABEL: Record<string, { text: string; cls: string }> = {
  bullish:        { text: '看多', cls: 'text-bull' },
  bearish:        { text: '看空', cls: 'text-bear' },
  watchlist:      { text: '觀察', cls: 'text-yellow-400' },
  risk_warning:   { text: '風險', cls: 'text-orange-400' },
  neutral:        { text: '中立', cls: 'text-muted-foreground' },
  mentioned_only: { text: '提及', cls: 'text-muted-foreground' },
};

function fmtRet(val: number | null | undefined): string {
  if (val == null) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

function retColor(val: number | null | undefined): string {
  if (val == null) return 'text-muted-foreground/50';
  if (val > 0) return 'text-bull';
  if (val < 0) return 'text-bear';
  return 'text-muted-foreground';
}

/** 縮短 display_name 到 4-5 字以塞入 chip：去掉「（XX）」括號 + 截長 */
function shortName(name: string): string {
  const stripped = name.replace(/[（(].*[）)]/g, '').trim();
  if (stripped.length <= 5) return stripped;
  return stripped.slice(0, 4) + '…';
}

// 對齊主頁 ScanResultsCompact 的 COMPACT_FWD：隔日開 + 1~10 日（每日） + 20 日 + 最高 + 最低
const FWD_COLS = [
  { key: 'openReturn' as const, label: '隔日開' },
  { key: 'd1Return' as const, label: '1日' },
  { key: 'd2Return' as const, label: '2日' },
  { key: 'd3Return' as const, label: '3日' },
  { key: 'd4Return' as const, label: '4日' },
  { key: 'd5Return' as const, label: '5日' },
  { key: 'd6Return' as const, label: '6日' },
  { key: 'd7Return' as const, label: '7日' },
  { key: 'd8Return' as const, label: '8日' },
  { key: 'd9Return' as const, label: '9日' },
  { key: 'd10Return' as const, label: '10日' },
  { key: 'd20Return' as const, label: '20日' },
  { key: 'maxGain' as const, label: '最高' },
  { key: 'maxLoss' as const, label: '最低' },
] as const;

export function YoutubeStockCard({ item, selected, onSelect }: Props) {
  const [expanded, setExpanded] = useState(false);

  const bestReason = (() => {
    const sorted = [...item.sources].sort((a, b) => {
      // sentiment priority: bullish > bearish > others, then by best_confidence proxy via order
      return 0;
    });
    return sorted.find(s => s.reason && s.reason.length > 0)?.reason ?? '';
  })();

  const sentimentLabel = (() => {
    if (item.bullish_count > item.bearish_count) return { text: `看多 ${item.bullish_count}/${item.mention_count}`, cls: 'text-bull' };
    if (item.bearish_count > item.bullish_count) return { text: `看空 ${item.bearish_count}/${item.mention_count}`, cls: 'text-bear' };
    return { text: `提及 ${item.mention_count}`, cls: 'text-muted-foreground' };
  })();

  const sourceChips = item.sources.slice(0, 3);
  const overflowCount = Math.max(0, item.sources.length - 3);
  const allSourcesTitle = item.sources.map(s => `· ${s.display_name}（${s.video_title}）`).join('\n');

  const perf = item.performance;
  const perfStatusHint = perf.status === 'no_data'
    ? '無 K 線資料'
    : perf.status === 'stale'
      ? '基準日太新，20 日尚未到位'
      : `基準收盤 ${perf.baseClose?.toFixed(2)}`;

  return (
    <div
      className={`rounded-lg border px-2.5 py-2 cursor-pointer transition-colors ${
        selected
          ? 'bg-secondary/60 border-sky-600/60 ring-1 ring-sky-500/40'
          : 'bg-card border-border/60 hover:bg-secondary/40'
      }`}
      onClick={() => onSelect?.(item.stock_code)}
    >
      {/* Row 1: 代號 + 名稱 + Rating + sentiment */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className="font-mono text-[11px] text-foreground/90 shrink-0">{item.stock_code}</span>
        <span className="text-[11px] text-foreground/80 truncate flex-1">{item.stock_name}</span>
        {item.rating && (
          <span
            className={`text-[9px] px-1.5 h-3.5 flex items-center rounded-sm border font-bold ${RATING_CLASS[item.rating] ?? ''}`}
            title={item.composite_score ? `總分 ${item.composite_score.toFixed(1)}` : undefined}
          >
            {item.rating}
          </span>
        )}
        <span className={`text-[10px] font-bold shrink-0 ${sentimentLabel.cls}`}>{sentimentLabel.text}</span>
      </div>

      {/* Row 2: 節目來源 chips */}
      <div className="flex items-center gap-1 mb-1 text-[10px]" title={allSourcesTitle}>
        <span className="text-muted-foreground/80 shrink-0">📺 {item.sources.length}</span>
        {sourceChips.map((src, i) => (
          <span
            key={`${src.video_id}-${i}`}
            className="text-[9px] px-1 h-3.5 flex items-center rounded-sm bg-secondary/60 text-foreground/70 truncate max-w-[80px]"
            title={`${src.display_name}\n影片：${src.video_title}\n情緒：${src.sentiment}\n理由：${src.reason || '—'}`}
          >
            {shortName(src.display_name)}
          </span>
        ))}
        {overflowCount > 0 && (
          <span className="text-[9px] px-1 h-3.5 flex items-center rounded-sm bg-secondary/40 text-muted-foreground">
            +{overflowCount}
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
          className="ml-auto text-[9px] text-muted-foreground hover:text-foreground px-1 rounded hover:bg-muted/40"
          aria-label={expanded ? '收合節目細節' : '展開節目細節'}
        >
          {expanded ? '收合' : '詳細'}
        </button>
      </div>

      {/* Row 3: best reason — 兩行內可見，超過 hover 看全文 or 點「詳細」展開所有節目 */}
      {bestReason && (
        <div className="text-[10px] text-foreground/70 mb-1 line-clamp-2 leading-snug" title={bestReason}>
          「{bestReason}」
        </div>
      )}

      {/* Row 4: N 日漲跌 6 欄 */}
      <div className="flex items-center gap-0.5" title={perfStatusHint}>
        {FWD_COLS.map(({ key, label }) => {
          const val = perf[key];
          return (
            <div key={key} className="flex-1 text-center">
              <div className="text-[8px] text-muted-foreground/60">{label}</div>
              <div className={`text-[9px] font-mono ${retColor(val)}`}>
                {fmtRet(val)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Expanded: 每個節目細節 */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/40 space-y-1.5 text-[10px]">
          {item.sources.map((src, idx) => {
            const sentLabel = SENTIMENT_LABEL[src.sentiment] ?? SENTIMENT_LABEL.mentioned_only;
            return (
              <div key={`${src.video_id}-${idx}`} className="border-l-2 border-border/60 pl-2">
                <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                  <span className={`font-bold ${sentLabel.cls}`}>{sentLabel.text}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-foreground/80">{src.display_name}</span>
                  <a
                    href={src.video_url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="text-sky-400 hover:underline ml-auto truncate max-w-[180px]"
                    title={src.video_title}
                  >
                    {src.video_title} ↗
                  </a>
                </div>
                {src.reason && (
                  <div className="text-foreground/70">
                    <span className="text-muted-foreground">理由：</span>{src.reason}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
