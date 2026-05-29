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
import { EntryStateBadge } from '@/components/EntryStateBadge';

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

  // 先排序：bullish/bearish 強訊號優先 > neutral/watchlist；
  // 找有實質 reason 的第一條當卡片摘要
  const sortedSources = [...item.sources].sort((a, b) => {
    const order: Record<string, number> = { bullish: 1, bearish: 2, risk_warning: 3, watchlist: 4, neutral: 5, mentioned_only: 6 };
    return (order[a.sentiment] ?? 9) - (order[b.sentiment] ?? 9);
  });
  // 卡片預覽用 context 或 reason，選較長的更有資訊量
  const bestSrc = sortedSources.find(s => (s.context && s.context.length > 0) || (s.reason && s.reason.length > 0));
  const bestReason = bestSrc ? (bestSrc.context || bestSrc.reason || '') : '';
  const bestAnalysts = bestSrc?.analysts ?? [];

  const sentimentLabel = (() => {
    const total = item.mention_count;
    const tooltip = `${total} 次提及（同一節目跨集算多次）｜多: ${item.bullish_count} / 空: ${item.bearish_count} / 中立: ${total - item.bullish_count - item.bearish_count}`;
    if (item.bullish_count > item.bearish_count) return { text: `看多 ${item.bullish_count}/${total}`, cls: 'text-bull', title: tooltip };
    if (item.bearish_count > item.bullish_count) return { text: `看空 ${item.bearish_count}/${total}`, cls: 'text-bear', title: tooltip };
    return { text: `提及 ${total}`, cls: 'text-muted-foreground', title: tooltip };
  })();

  // 同節目跨集（如錢線上中下）只顯示 1 個 chip — dedupe by display_name
  const uniqueSourcesByName = (() => {
    const seen = new Set<string>();
    const out: typeof item.sources = [];
    for (const s of item.sources) {
      if (seen.has(s.display_name)) continue;
      seen.add(s.display_name);
      out.push(s);
    }
    return out;
  })();
  const sourceChips = uniqueSourcesByName.slice(0, 3);
  const overflowCount = Math.max(0, uniqueSourcesByName.length - 3);
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
        {item.entryGate && <EntryStateBadge gate={item.entryGate} size="xs" />}
        <span title={sentimentLabel.title} className={`text-[10px] font-bold shrink-0 cursor-help ${sentimentLabel.cls}`}>{sentimentLabel.text}</span>
      </div>

      {/* Row 2: 節目來源 chips（去重後算節目數）*/}
      <div className="flex items-center gap-1 mb-1 text-[10px]" title={allSourcesTitle}>
        <span className="text-muted-foreground/80 shrink-0" title={`${uniqueSourcesByName.length} 個節目 / 共 ${item.sources.length} 條提及`}>
          📺 {uniqueSourcesByName.length}
        </span>
        {sourceChips.map((src, i) => (
          <a
            key={`${src.video_id}-${i}`}
            href={src.video_url}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-[9px] px-1 h-3.5 flex items-center rounded-sm bg-secondary/60 text-foreground/70 hover:bg-sky-900/50 hover:text-sky-300 truncate max-w-[80px]"
            title={`${src.display_name}\n影片：${src.video_title}\n情緒：${src.sentiment}\n理由：${src.reason || '—'}\n（點擊開啟 YouTube）`}
          >
            {shortName(src.display_name)}
          </a>
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
          {bestAnalysts.length > 0 && (
            <span className="text-amber-400 mr-1">【{bestAnalysts.join('/')}】</span>
          )}
          「{bestReason}」
        </div>
      )}

      {/* Row 4: N 日漲跌 6 欄 — 全空時 collapse 成單一 hint chip */}
      {(() => {
        const allEmpty = FWD_COLS.every(({ key }) => perf[key] == null);
        if (allEmpty) {
          return (
            <div
              title={perfStatusHint}
              className="text-[9px] text-muted-foreground/70 italic flex items-center gap-1 py-0.5"
            >
              <span>📅</span>
              <span>
                {perf.status === 'no_data'
                  ? '無 K 線資料'
                  : perf.status === 'stale'
                    ? '尚無交易日 K 線（等下個交易日結算）'
                    : 'N 日漲跌待結算'}
              </span>
            </div>
          );
        }
        return (
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
        );
      })()}

      {/* Expanded: 每個節目細節（依情緒排序，多 → 空 → 觀察 → 風險 → 中性） */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/40 space-y-2 text-[10px]">
          <div className="text-[9px] text-muted-foreground">
            全部 {item.sources.length} 條提及 · 依情緒排序（多→空→觀察→風險→中性）
          </div>
          {sortedSources.map((src, idx) => {
            const sentLabel = SENTIMENT_LABEL[src.sentiment] ?? SENTIMENT_LABEL.mentioned_only;
            // 顯示分析師條件：有 analysts 且至少有一位不是節目 display_name (排除 fallback)
            // 也過濾掉 display_name 內已含的 analyst 名（如「股市易點靈（許毓玲）」內已有「許毓玲」）
            const realAnalysts = (src.analysts || []).filter(
              a => a !== src.display_name
                && a !== '(未知)'
                && !a.includes('主持群')
                && !src.display_name.includes(a)
            );
            // 隱藏理由條件：reason 是 context 的 prefix 或 substring
            const reasonRedundant =
              !src.reason ||
              src.reason === src.context ||
              (src.context && src.context.startsWith(src.reason)) ||
              (src.context && src.context.includes(src.reason));
            return (
              <div key={`${src.video_id}-${idx}`} className="border-l-2 border-border/60 pl-2 py-0.5">
                <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                  <span className={`font-bold ${sentLabel.cls}`}>{sentLabel.text}</span>
                  <span className="text-muted-foreground">·</span>
                  <a
                    href={src.video_url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="text-foreground font-medium hover:text-sky-300 hover:underline"
                    title={`${src.video_title}\n（點擊開啟 YouTube）`}
                  >
                    {src.display_name}
                  </a>
                  {realAnalysts.length > 0 && (
                    <>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-amber-400">{realAnalysts.join('/')}</span>
                    </>
                  )}
                  <a
                    href={src.video_url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="text-sky-400 hover:underline ml-auto truncate max-w-[120px]"
                    title={src.video_title}
                  >
                    看影片 ↗
                  </a>
                </div>
                {src.context && (
                  <div className="text-foreground/80 leading-relaxed">
                    「{src.context}」
                  </div>
                )}
                {!reasonRedundant && (
                  <div className="text-foreground/60 leading-relaxed mt-0.5">
                    <span className="text-muted-foreground">摘要：</span>{src.reason}
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
