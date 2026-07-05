'use client';

/**
 * 課程教學卡（收合區塊，純教學顯示、不進任何選股/排序）— 2026-07-05 批次A
 *
 * 三段內容全部抄課程投影片原文：
 *   1. 五步驟 + 5 個操作賺錢口訣（CH5-1 投影片 p02）
 *   2. 趨勢全景圖：多空循環階段 + 本檔當前位置對照（漏網-7，CH2-3/2-4 林穎「印一張趨勢圖貼電腦旁」）
 *   3. 7 個做多進場位置 × 課程勝率註記（小修-10，CH6-1~6-7；只引課程真的給過的數字）
 */

import { useMemo, useState } from 'react';
import type { CandleWithIndicators } from '@/types';
import { detectTrend, detectTrendPosition, classifyConsolidationShape } from '@/lib/analysis/trendAnalysis';

// ── 五步驟 + 口訣（CH5-1 投影片原文） ──────────────────────────────────────────

const FIVE_STEPS = ['選股', '進場', '停損', '操作', '停利'] as const;

const FIVE_MOTTOS = [
  { motto: '順勢不逆勢', hint: '永遠跟著趨勢做方向，不逆勢操作' },
  { motto: '買強不買弱', hint: '選當下的強勢股，不買弱勢股' },
  { motto: '買低不追高', hint: '等回檔低點買、高點賣，才能獲利' },
  { motto: '停損不套牢', hint: '用停損控制風險，保住本金再戰' },
  { motto: '停利不猶豫', hint: '有獲利按紀律立刻入袋，不猶豫' },
] as const;

// ── 7 個做多進場位置 × 課程勝率註記（CH6-1 ~ 6-7 投影片；數字只引課程給過的）──

const ENTRY_POSITIONS = [
  {
    pos: '位置1', letter: 'C', name: '盤整的突破',
    rule: '紅K帶量收盤突破盤整上頸線',
    winRate: '課程：出升→主升位置勝率約 8 成、主升→末升約 7 成；高檔已漲一倍防假突破（錢不要賺）',
  },
  {
    pos: '位置2', letter: 'B', name: '回後買上漲',
    rule: '回檔不破前低、站回5均、大量紅K過前高',
    winRate: '課程：回檔越淺越強（黃金分割 0.318 最強），回檔逾 0.618 不買',
  },
  {
    pos: '位置3', letter: 'K', name: 'K線橫盤的突破',
    rule: '連 3 天收盤不過高不破低（以盤代跌）→ 大量紅K突破最高點',
    winRate: '課程：以盤代跌＝多方強；跌破 5 均賣',
  },
  {
    pos: '位置4', letter: 'N', name: '6 個型態確認',
    rule: '頭肩底/N字底/三重底等 6 型態，大量中長紅K突破頸線',
    winRate: '課程：只挑最高勝率 6 型態（32 種裡）；三重底勝率最高、頭肩底約六七成到目標價',
  },
  {
    pos: '位置5', letter: 'J', name: '突破 ABC 修正下降切線',
    rule: '多頭一波後 ABC 短空，大量長紅K突破原始下降切線',
    winRate: '課程：修正 ≤20 天＝飆旗，可算目標價 D；空單要回補反手做多',
  },
  {
    pos: '位置6', letter: 'M', name: '突破上升軌道線',
    rule: '通道內緩漲後大量長紅K突破軌道上緣＝慣性改變',
    winRate: '課程：月線之上＋月線向上是鐵則，不能改變',
  },
  {
    pos: '位置7', letter: 'L', name: '突破飆股大量黑K最高點',
    rule: '飆股換手黑K後，3 天內大量長紅K收盤過黑K高點',
    winRate: '課程：換手再轉強；停損＝黑K低點',
  },
] as const;

// ── 趨勢全景圖（多空循環 7 階段；當前位置由 detectTrendPosition 對照）──────────

const PANORAMA_STAGES = [
  { key: 'base',     label: '打底/盤整' },
  { key: 'up',       label: '初升→主升' },
  { key: 'pressure', label: '接近壓力' },
  { key: 'end-up',   label: '末升段' },
  { key: 'down',     label: '下跌段' },
  { key: 'support',  label: '接近支撐' },
  { key: 'end-down', label: '末跌段' },
] as const;

type PanoramaKey = typeof PANORAMA_STAGES[number]['key'];

function stageOf(position: string): PanoramaKey {
  switch (position) {
    case '多頭上升段':
    case '起漲段':
    case '主升段':      return 'up';
    case '接近壓力區':  return 'pressure';
    case '末升段(高檔)': return 'end-up';
    case '空頭下跌段':
    case '起跌段':
    case '主跌段':      return 'down';
    case '接近支撐區':  return 'support';
    case '末跌段(低檔)': return 'end-down';
    default:            return 'base'; // 盤整觀望
  }
}

/** 一條簡化的多空循環波形（打底→初升→主升→末升→下跌→末跌→打底），x 對應 7 階段 */
function PanoramaSvg({ active }: { active: PanoramaKey }) {
  // 波形節點（x: 0-280, y: 0-72；y 越小越高）
  const path = 'M4,56 L36,54 L44,58 L52,52 L88,34 L124,22 L152,10 L164,8 L176,14 L200,34 L224,50 L240,56 L252,62 L268,64 L276,62';
  // 各階段在 x 軸的中心（與 PANORAMA_STAGES 對齊）
  const centers: Record<PanoramaKey, { x: number; y: number }> = {
    'base':     { x: 28,  y: 55 },
    'up':       { x: 96,  y: 31 },
    'pressure': { x: 138, y: 16 },
    'end-up':   { x: 164, y: 8 },
    'down':     { x: 204, y: 37 },
    'support':  { x: 232, y: 53 },
    'end-down': { x: 260, y: 63 },
  };
  const dot = centers[active];
  return (
    <svg viewBox="0 0 280 76" className="w-full h-auto" role="img" aria-label="趨勢全景圖">
      <path d={path} fill="none" strokeWidth="1.5" className="stroke-muted-foreground/50" />
      {/* 當前位置 */}
      <circle cx={dot.x} cy={dot.y} r="4" className="fill-amber-400" />
      <circle cx={dot.x} cy={dot.y} r="7" fill="none" strokeWidth="1" className="stroke-amber-400/60" />
    </svg>
  );
}

// ── 主元件 ────────────────────────────────────────────────────────────────────

export default function CourseTeachingBlock({
  candles,
  index,
}: {
  candles: CandleWithIndicators[];
  index: number;
}) {
  const [open, setOpen] = useState(false);

  const { trend, position, consolShape } = useMemo(() => {
    if (!candles.length || index < 0 || index >= candles.length) {
      return { trend: null, position: null, consolShape: null };
    }
    const t = detectTrend(candles, index);
    return {
      trend: t,
      position: detectTrendPosition(candles, index),
      consolShape: t === '盤整' ? classifyConsolidationShape(candles, index) : null,
    };
  }, [candles, index]);

  const active = stageOf(position ?? '盤整觀望');

  return (
    <div className="mt-3 pt-3 border-t border-border">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-left"
      >
        <span className="text-[10px] font-bold text-muted-foreground">📚 課程教學卡（五步驟・進場位置・趨勢全景）</span>
        <span className="text-[11px] font-mono">
          {position && <span className="text-amber-400 font-bold mr-1">{position}</span>}
          <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          {/* 1. 趨勢全景圖 + 當前位置 */}
          <div>
            <div className="text-[10px] text-muted-foreground mb-1">
              趨勢全景圖 — 本檔目前：<span className="text-amber-400 font-bold">{position ?? '—'}</span>
              {consolShape && <span className="ml-1">（{consolShape.shape}）</span>}
            </div>
            <PanoramaSvg active={active} />
            <div className="grid grid-cols-7 text-[8px] text-muted-foreground/80 text-center">
              {PANORAMA_STAGES.map(s => (
                <span key={s.key} className={s.key === active ? 'text-amber-400 font-bold' : ''}>{s.label}</span>
              ))}
            </div>
            {trend && (
              <div className="mt-1 text-[9px] text-muted-foreground/70">
                位置決定做短做長與進場方式（CH5-1）；同樣的訊號在不同位置勝率天差地別（CH6-1）。
              </div>
            )}
          </div>

          {/* 2. 五步驟 + 5 口訣 */}
          <div>
            <div className="text-[10px] text-muted-foreground mb-1">炒股五步驟（選股做好＝成功一半，CH5-1）</div>
            <div className="flex items-center gap-1 flex-wrap">
              {FIVE_STEPS.map((s, i) => (
                <span key={s} className="flex items-center gap-1">
                  <span className="text-[11px] px-2 py-0.5 rounded bg-secondary/60 font-bold">{i + 1} {s}</span>
                  {i < FIVE_STEPS.length - 1 && <span className="text-muted-foreground/50 text-[10px]">→</span>}
                </span>
              ))}
            </div>
            <div className="mt-1.5 space-y-0.5">
              {FIVE_MOTTOS.map(m => (
                <div key={m.motto} className="text-[10px] flex gap-1.5">
                  <span className="font-bold shrink-0">{m.motto}</span>
                  <span className="text-muted-foreground">{m.hint}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 3. 7 個做多進場位置 × 課程勝率註記 */}
          <div>
            <div className="text-[10px] text-muted-foreground mb-1">7 個做多進場位置（CH6-1~6-7；勝率為課程口述/投影片經驗值，非本站回測）</div>
            <div className="space-y-1">
              {ENTRY_POSITIONS.map(p => (
                <div key={p.pos} className="text-[10px] px-2 py-1 rounded bg-secondary/40" title={p.rule}>
                  <span className="font-bold">{p.pos}</span>
                  <span className="mx-1 px-1 rounded bg-secondary font-mono">{p.letter}</span>
                  <span className="font-bold">{p.name}</span>
                  <span className="text-muted-foreground"> — {p.rule}</span>
                  <div className="text-muted-foreground/80 mt-0.5">{p.winRate}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="text-[9px] text-muted-foreground/70">
            純教學顯示（課程 CH5-1／CH6），不進選股與排序；實測勝率請看誠實 edge 排行。
          </div>
        </div>
      )}
    </div>
  );
}
