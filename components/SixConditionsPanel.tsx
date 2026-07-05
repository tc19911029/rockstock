'use client';

import { useMemo, useState } from 'react';
import type { CandleWithIndicators } from '@/types';
import { useReplayStore } from '@/store/replayStore';
import { SixConditionsResult } from '@/lib/analysis/trendAnalysis';
import { detectSellSignals } from '@/lib/analysis/sellSignals';
import { computeProfitTargets } from '@/lib/sell/profitTargets';
import { EmptyState } from '@/components/shared';
import { HeavinessBadgeFor } from '@/components/shared/HeavinessBadge';
import { classifyMarket } from '@/lib/market/classify';
import ProhibitionsBlock from './ProhibitionsBlock';
import CourseTeachingBlock from './CourseTeachingBlock';
import { detectShortEntries } from '@/lib/analysis/shortEntries';
import { CORE_SCORE_MIN, BOOK_VOL_RATIO_MIN, BOOK_BODY_PCT_MIN } from '@/lib/analysis/bookThresholds';

const HIGH_WIN_POS_NUM: Record<string, string> = {
  '🎯 打底趨勢確認': '①',
  '🎯 回後買上漲':   '②',
  '🎯 盤整突破':     '③',
  '🎯 均線糾結突破': '④',
  '🎯 強勢短回續攻': '⑤',
  '🎯 假跌破反彈':   '⑥',
};

const CONDITION_LABELS = [
  { key: 'trend',     icon: '①', name: '趨勢條件', tip: '日線波浪型態符合「頭頭高、底底高」多頭架構', required: true },
  { key: 'ma',        icon: '②', name: '均線條件', tip: 'MA5>MA10>MA20 三線多排，MA10/20 方向向上', required: true },
  { key: 'position',  icon: '③', name: '股價位置', tip: '收盤在 MA10、MA20 之上，判斷初升/主升/末升段', required: true },
  { key: 'volume',    icon: '④', name: '成交量',   tip: `攻擊量 ≥ 前一日 × ${BOOK_VOL_RATIO_MIN}（書本 p.54，2 倍更強）`, required: true },
  { key: 'kbar',      icon: '⑤', name: '進場K線', tip: `價漲、量增、紅K實體棒 > ${BOOK_BODY_PCT_MIN}%`, required: true },
  { key: 'indicator', icon: '⑥', name: '指標參考', tip: 'MACD 綠柱縮短或紅柱延長；KD 黃金交叉向上多排', required: false },
] as const;

type ConditionKey = typeof CONDITION_LABELS[number]['key'];

function _ScoreDots({ score, total = 6 }: { score: number; total?: number }) {
  return (
    <span className="flex gap-1 items-center">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`inline-block w-2.5 h-2.5 rounded-full transition-colors ${
            i < score ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.4)]' : 'bg-muted-foreground/30'
          }`}
        />
      ))}
    </span>
  );
}

/** Mini progress bar for quantitative conditions */
function MiniProgress({ value, target, pass }: { value: number; target: number; pass: boolean }) {
  const pct = Math.min(100, Math.max(0, (value / target) * 100));
  return (
    <div className="w-full bg-muted rounded-full h-1 overflow-hidden mt-1">
      <div
        className={`h-full rounded-full transition-all ${pass ? 'bg-green-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-red-500/60'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Metric badge showing the key numeric value */
function MetricBadge({ label, pass }: { label: string; pass: boolean }) {
  return (
    <span className={`text-[10px] font-mono px-2 py-0.5 rounded-md whitespace-nowrap shrink-0 ${
      pass ? 'bg-green-900/40 text-green-300 border border-green-800/50' : 'bg-muted text-muted-foreground border border-transparent'
    }`}>
      {label}
    </span>
  );
}

function ConditionRow({
  label,
  pass,
  detail,
  metric,
  progress,
  changed,
  expanded,
  onToggle,
}: {
  label: { icon: string; name: string; tip: string; required: boolean };
  pass: boolean;
  detail: string;
  metric?: string;
  progress?: { value: number; target: number };
  changed?: 'gained' | 'lost';
  expanded: boolean;
  onToggle: () => void;
}) {
  const dot = pass
    ? <span className="text-green-400 text-sm">●</span>
    : <span className="text-red-400 text-sm">●</span>;

  return (
    <div className={`border-b border-border last:border-0 ${
      changed === 'gained' ? 'bg-green-900/20' : changed === 'lost' ? 'bg-red-900/20' : ''
    }`}>
      <button
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
        onClick={onToggle}
      >
        {dot}
        <span className="text-muted-foreground/70 text-xs w-4 font-mono">{label.icon}</span>
        <span className="text-sm font-medium w-16 shrink-0 text-foreground" title={label.tip}>
          {label.name}
        </span>
        {changed === 'gained' && <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-green-600 text-white font-bold animate-pulse">NEW</span>}
        {changed === 'lost' && <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-red-600 text-white font-bold">LOST</span>}
        {metric && <MetricBadge label={metric} pass={pass} />}
        <span className="flex-1" />
        <span className={`text-muted-foreground/40 text-[10px] transition-transform ${expanded ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {/* Progress bar (always visible for quantitative conditions) */}
      {progress && (
        <div className="px-3 pb-1">
          <MiniProgress value={progress.value} target={progress.target} pass={pass} />
        </div>
      )}
      {expanded && (
        <div className="px-4 pb-2 text-xs text-muted-foreground leading-relaxed bg-secondary/40">
          <div className="whitespace-pre-line break-words">{detail}</div>
        </div>
      )}
    </div>
  );
}

export default function SixConditionsPanel() {
  const sixConditions     = useReplayStore(s => s.sixConditions);
  const prevSixConditions = useReplayStore(s => s.prevSixConditions);
  const allCandles    = useReplayStore(s => s.allCandles);
  const currentIndex  = useReplayStore(s => s.currentIndex);
  const ticker        = useReplayStore(s => s.currentStock?.ticker);
  const market        = classifyMarket(ticker ?? '');
  const [expanded, setExpanded] = useState<ConditionKey | null>(null);

  // detectSellSignals 跑 15+ 條規則，沒 memo 會在每個 expand/click 重算
  const sellSignals = useMemo(
    () => detectSellSignals(allCandles, currentIndex),
    [allCandles, currentIndex],
  );

  if (!sixConditions) {
    return (
      <EmptyState
        variant="compact"
        icon="📊"
        title="尚未載入股票"
        description="請先在上方選擇一檔股票，即可查看六大條件評分"
      />
    );
  }

  const sc = sixConditions as SixConditionsResult;
  const score = sc.totalScore;
  const coreScore = sc.coreScore ?? 0;
  const isCoreReady = sc.isCoreReady ?? false;

  const scoreColor =
    isCoreReady ? 'text-green-400' :
    coreScore >= CORE_SCORE_MIN ? 'text-yellow-400' :
    'text-red-400';

  const toggle = (key: ConditionKey) =>
    setExpanded(prev => prev === key ? null : key);

  // Build metric badges and progress bars from numeric data
  const volRatio = sc.volume.ratio;
  const volThreshold = sc.volume.threshold ?? BOOK_VOL_RATIO_MIN;
  const bodyPct = sc.kbar.bodyPct ?? 0;
  const kdK = sc.indicator.kdK;
  const macdOSC = sc.indicator.macdOSC;
  const deviation = sc.position.deviation;

  // Detect condition transitions (for "just changed" indicators)
  const prev = prevSixConditions as SixConditionsResult | null;
  const changedKeys: Set<ConditionKey> = new Set();
  if (prev) {
    const keys: Array<{ key: ConditionKey; now: boolean; was: boolean }> = [
      { key: 'trend',     now: sc.trend.pass,     was: prev.trend.pass },
      { key: 'ma',        now: sc.ma.pass,        was: prev.ma.pass },
      { key: 'position',  now: sc.position.pass,  was: prev.position.pass },
      { key: 'volume',    now: sc.volume.pass,     was: prev.volume.pass },
      { key: 'kbar',      now: sc.kbar.pass,      was: prev.kbar.pass },
      { key: 'indicator', now: sc.indicator.pass,  was: prev.indicator.pass },
    ];
    for (const { key, now, was } of keys) {
      if (now !== was) changedKeys.add(key);
    }
  }

  const rows: Array<{
    key: ConditionKey;
    pass: boolean;
    detail: string;
    metric?: string;
    progress?: { value: number; target: number };
    changed?: 'gained' | 'lost';
  }> = [
    {
      key: 'trend', pass: sc.trend.pass, detail: sc.trend.detail,
      metric: sc.trend.state,
      changed: changedKeys.has('trend') ? (sc.trend.pass ? 'gained' : 'lost') : undefined,
    },
    {
      key: 'ma', pass: sc.ma.pass, detail: sc.ma.detail,
      changed: changedKeys.has('ma') ? (sc.ma.pass ? 'gained' : 'lost') : undefined,
    },
    {
      key: 'position', pass: sc.position.pass, detail: sc.position.detail,
      metric: deviation !== null && deviation !== undefined ? `月線乖離${(deviation * 100).toFixed(1)}%` : undefined,
      changed: changedKeys.has('position') ? (sc.position.pass ? 'gained' : 'lost') : undefined,
    },
    {
      key: 'volume', pass: sc.volume.pass, detail: sc.volume.detail,
      metric: volRatio !== null && volRatio !== undefined ? `×${volRatio}倍` : undefined,
      progress: volRatio !== null && volRatio !== undefined ? { value: volRatio, target: volThreshold } : undefined,
      changed: changedKeys.has('volume') ? (sc.volume.pass ? 'gained' : 'lost') : undefined,
    },
    {
      key: 'kbar', pass: sc.kbar.pass, detail: sc.kbar.detail,
      metric: `實體${(bodyPct * 100).toFixed(1)}%`,
      progress: { value: bodyPct, target: BOOK_BODY_PCT_MIN / 100 },
      changed: changedKeys.has('kbar') ? (sc.kbar.pass ? 'gained' : 'lost') : undefined,
    },
    {
      key: 'indicator', pass: sc.indicator.pass, detail: sc.indicator.detail,
      metric: [
        macdOSC !== null && macdOSC !== undefined ? `OSC${macdOSC > 0 ? '+' : ''}${macdOSC.toFixed(2)}` : null,
        kdK !== null && kdK !== undefined ? `K${kdK.toFixed(0)}` : null,
      ].filter(Boolean).join(' ') || undefined,
      changed: changedKeys.has('indicator') ? (sc.indicator.pass ? 'gained' : 'lost') : undefined,
    },
  ];

  return (
    <div className="bg-secondary rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-secondary border-b border-border">
        <span className="text-sm font-semibold text-foreground">六大進場條件</span>
        <span className={`text-base font-bold tabular-nums ${scoreColor}`}>{score}/6</span>
      </div>

      {/* Rows */}
      <div>
        {rows.map((row, i) => {
          const label = CONDITION_LABELS[i];
          return (
            <ConditionRow
              key={row.key}
              label={label}
              pass={row.pass}
              detail={row.detail}
              metric={row.metric}
              progress={row.progress}
              changed={row.changed}
              expanded={expanded === row.key}
              onToggle={() => toggle(row.key)}
            />
          );
        })}
      </div>

      {/* Summary */}
      <div className={`px-3 py-3 border-t border-border ${
        isCoreReady ? 'bg-green-900/40' : coreScore >= CORE_SCORE_MIN ? 'bg-yellow-900/30' : 'bg-secondary/60'
      }`}>
        <p className={`text-sm font-bold ${
          isCoreReady ? 'text-green-300' : coreScore >= CORE_SCORE_MIN ? 'text-yellow-300' : 'text-muted-foreground'
        }`}>
          {isCoreReady
            ? sc.indicator.pass
              ? '✅ 核心5條件全過 + 指標確認 = 6/6 — 可考慮進場'
              : '✅ 核心5條件全過（指標未確認）— 主結構已成立、可進場'
            : coreScore >= CORE_SCORE_MIN
            ? `⏳ 核心 ${coreScore}/5 已過、其餘觀察後續`
            : `🚫 核心 ${coreScore}/5 — 不足 5 條、建議觀望（書本：核心 5 條必過）`}
        </p>
        {isCoreReady && !sc.indicator.pass && (
          <p className="text-[10px] text-yellow-500 mt-0.5">📖 朱書邏輯：核心 5 條（趨/位/K/均/量）必過，第⑥指標為「加分項」、可後補</p>
        )}
      </div>

      {/* 🎯 高勝率位置加成（書本 p.749-754 + 圖表 12-1-7） */}
      {sc.highWinTags.length > 0 && (
        <div className="px-3 py-2 border-t border-border bg-green-900/10">
          <div className="text-[10px] font-bold text-green-400 mb-1">🎯 高勝率位置加成（{sc.highWinTags.length}/6）</div>
          <div className="flex flex-wrap gap-1">
            {sc.highWinTags.map(tag => {
              const num = HIGH_WIN_POS_NUM[tag] ?? '';
              return (
                <span key={tag} className="text-[10px] px-2 py-0.5 rounded bg-green-900/40 text-green-300 border border-green-800/50">
                  {num && <span className="text-green-500 mr-0.5">{num}</span>}{tag.replace('🎯 ', '')}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* 進場 10 大戒律狀態（書本：硬性禁忌，任一觸發即不應進場） */}
      <ProhibitionsBlock />

      {/* Sell Signals */}
      {sellSignals.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="text-[10px] font-bold text-muted-foreground mb-1.5">⚠ 出場警示</div>
          <div className="space-y-1">
            {sellSignals.map(sig => (
              <div key={sig.type} className={`text-[11px] px-2 py-1.5 rounded ${
                sig.severity === 'high' ? 'bg-red-900/40 text-red-300' :
                sig.severity === 'medium' ? 'bg-orange-900/40 text-orange-300' :
                'bg-yellow-900/30 text-yellow-400'
              }`}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-bold">{sig.label}</span>
                  <HeavinessBadgeFor market={market} signalId={sig.type} className="shrink-0" />
                </div>
                <div className="text-[10px] opacity-80 leading-relaxed mt-0.5">{sig.detail}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 課程 CH9-2（2026-07-04）：獲利目標 = 六種壓力位（純顯示，不進 gate/排序） */}
      <ProfitTargetsBlock candles={allCandles} index={currentIndex} />

      {/* 做空 7 進場位置（2026-07-05 批次C）：課程 CH6-8~14 對照顯示，回測未過 edge 不進掃描 */}
      <ShortEntriesBlock candles={allCandles} index={currentIndex} />

      {/* 課程教學卡（2026-07-05 批次A）：五步驟＋口訣／趨勢全景圖／7 進場位置勝率（純教學） */}
      <CourseTeachingBlock candles={allCandles} index={currentIndex} />
    </div>
  );
}

/**
 * 做空 7 進場位置顯示（課程 CH6-8~14，批次C 2026-07-05）
 * 回測（backtest-short-entries，24,850 筆）：絕對做空紀律模擬 test 全負、市場中立 α train/test 翻面
 * → 不開掃描軌，純走圖對照 + 多單警訊參考。只在當日有命中時渲染。
 */
function ShortEntriesBlock({ candles, index }: { candles: CandleWithIndicators[]; index: number }) {
  const signals = useMemo(
    () => (candles.length && index >= 0 && index < candles.length ? detectShortEntries(candles, index) : []),
    [candles, index],
  );
  if (!signals.length) return null;
  return (
    <div className="mt-3 pt-3 border-t border-border">
      <div className="text-[10px] font-bold text-muted-foreground mb-1.5">🐻 做空進場位置命中（課程 CH6-8~14 對照）</div>
      <div className="space-y-1">
        {signals.map(s => (
          <div key={s.id} className="text-[11px] px-2 py-1.5 rounded bg-secondary/40" title={s.detail}>
            <div className="flex items-center justify-between">
              <span className="font-bold">位置{s.position} {s.name}</span>
              <span className="font-mono text-muted-foreground">停損(回補) {s.stopLoss.toFixed(2)}{s.targetPrice != null ? `｜目標 ${s.targetPrice.toFixed(2)}` : ''}</span>
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{s.detail}</div>
          </div>
        ))}
      </div>
      <div className="mt-1 text-[9px] text-muted-foreground/70 leading-relaxed">
        課程紀律：停損＝進場黑K最高點、站上 5 均回補。⚠️ 2026-07-05 回測 24,850 筆：絕對做空期望 test 全負、
        對大盤超額兩段翻面 — 無穩定 edge，僅供課程對照與多單警訊，不是做空建議（位置6/7 跌破後反而常相對大盤走強）。
      </div>
    </div>
  );
}

/** 課程 CH9-2 六壓力位獲利目標（收合區塊；短線=日線、長線=週線） */
function ProfitTargetsBlock({ candles, index }: { candles: CandleWithIndicators[]; index: number }) {
  const [open, setOpen] = useState(false);
  const short = useMemo(() => computeProfitTargets(candles, 'short', index), [candles, index]);
  const long = useMemo(
    () => (open ? computeProfitTargets(candles, 'long', index) : null),
    [candles, index, open],
  );
  if (!short) return null;
  const upPct = short.nearestAbove != null && short.asOfClose > 0
    ? ((short.nearestAbove / short.asOfClose - 1) * 100).toFixed(1)
    : null;
  return (
    <div className="mt-3 pt-3 border-t border-border">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-left"
      >
        <span className="text-[10px] font-bold text-muted-foreground">🎯 獲利目標（課程 9-2 六壓力位）</span>
        <span className="text-[11px] font-mono">
          {short.nearestAbove != null
            ? <>最近壓力 <span className="font-bold text-foreground">{short.nearestAbove.toFixed(2)}</span>{upPct != null && <span className="text-muted-foreground">（+{upPct}%）</span>}</>
            : <span className="text-muted-foreground">上方無壓（創新高）</span>}
          <span className="ml-1 text-muted-foreground">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {/* 課程 9-2 唯一的判斷式：獲利空間 ≥10% 才進場；只有 3~5% 這筆不做（2026-07-05 補） */}
      {upPct != null && Number(upPct) < 10 && (
        <div className="mt-1 text-[10px] px-2 py-1 rounded bg-rose-900/30 text-rose-300">
          ⚠️ 課程 9-2：距最近壓力僅 +{upPct}%，獲利空間不足 10% — 這筆不建議進場（扣掉停損 5% 划不來）
        </div>
      )}
      {open && (
        <div className="mt-1.5 space-y-2">
          {([['短線（日線）', short.targets], ...(long ? [['長線（週線）', long.targets] as const] : [])] as Array<readonly [string, typeof short.targets]>).map(([title, targets]) => (
            <div key={title}>
              <div className="text-[10px] text-muted-foreground mb-0.5">{title}</div>
              <div className="space-y-0.5">
                {targets.map(t => (
                  <div key={t.type} className="flex items-center justify-between text-[11px] px-2 py-1 rounded bg-secondary/40" title={t.detail}>
                    <span className="text-muted-foreground">{t.label}</span>
                    <span className={`font-mono ${t.price != null ? 'text-foreground font-bold' : 'text-muted-foreground/60'}`}>
                      {t.price != null ? t.price.toFixed(2) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="text-[9px] text-muted-foreground/70">
            量價研判壓力位置預估獲利幅度（CH9-2）；手填 target 不受影響。純顯示、不進選股。
          </div>
        </div>
      )}
    </div>
  );
}
