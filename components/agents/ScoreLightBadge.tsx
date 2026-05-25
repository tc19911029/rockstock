/**
 * ScoreLightBadge — 統一的 0-100 分 + 5 階燈號 + 信心程度 badge
 *
 * 給 AgentScorePanel、StockGradeSummary、MultiAgentTopPanel list 共用
 */

import type {
  ScoreConfidence,
  ScoreLight,
  StockGrade,
} from '@/lib/agents/scoringTypes';

const LIGHT_STYLE: Record<ScoreLight, { dot: string; chip: string; label: string }> = {
  green:        { dot: 'bg-green-500',  chip: 'bg-green-700/40 text-green-200 border-green-500/60',     label: '綠燈' },
  yellow_green: { dot: 'bg-lime-500',   chip: 'bg-lime-700/40 text-lime-200 border-lime-500/60',         label: '黃綠' },
  yellow:       { dot: 'bg-yellow-500', chip: 'bg-yellow-700/40 text-yellow-200 border-yellow-500/60',   label: '黃燈' },
  orange_red:   { dot: 'bg-orange-500', chip: 'bg-orange-700/40 text-orange-200 border-orange-500/60',   label: '橘紅' },
  red:          { dot: 'bg-red-500',    chip: 'bg-red-700/40 text-red-200 border-red-500/60',           label: '紅燈' },
};

const CONFIDENCE_LABEL: Record<ScoreConfidence, string> = {
  high: '信心高',
  medium: '信心中',
  low: '信心低',
};

const CONFIDENCE_STYLE: Record<ScoreConfidence, string> = {
  high: 'text-foreground',
  medium: 'text-muted-foreground',
  low: 'text-muted-foreground/60 italic',
};

const GRADE_STYLE: Record<StockGrade, { bg: string; text: string; border: string; tagline: string }> = {
  A: { bg: 'bg-emerald-700/40',  text: 'text-emerald-200', border: 'border-emerald-500/60', tagline: '優先觀察 / 等買點' },
  B: { bg: 'bg-sky-700/40',      text: 'text-sky-200',     border: 'border-sky-500/60',     tagline: '短線 / 波段候選' },
  C: { bg: 'bg-yellow-700/40',   text: 'text-yellow-200',  border: 'border-yellow-500/60',  tagline: '觀察名單' },
  D: { bg: 'bg-orange-700/40',   text: 'text-orange-200',  border: 'border-orange-500/60',  tagline: '高風險追高股' },
  E: { bg: 'bg-red-700/40',      text: 'text-red-200',     border: 'border-red-500/60',     tagline: '避開' },
};

export function lightStyle(light: ScoreLight) {
  return LIGHT_STYLE[light];
}

export function gradeStyle(grade: StockGrade) {
  return GRADE_STYLE[grade];
}

interface ScoreLightBadgeProps {
  score: number;
  light: ScoreLight;
  confidence?: ScoreConfidence;
  /** 'sm' = 行內小 badge、'md' = 卡片內中 badge、'lg' = 主標題 badge */
  size?: 'sm' | 'md' | 'lg';
  /** 額外顯示燈號中文 label(綠燈/黃綠 等)*/
  showLabel?: boolean;
}

export function ScoreLightBadge({
  score,
  light,
  confidence,
  size = 'md',
  showLabel = false,
}: ScoreLightBadgeProps) {
  const style = LIGHT_STYLE[light];
  const sizeClass =
    size === 'lg' ? 'text-2xl px-3 py-1.5 gap-2'
    : size === 'sm' ? 'text-[10px] px-1.5 py-0.5 gap-1'
    : 'text-sm px-2 py-1 gap-1.5';
  const dotSize =
    size === 'lg' ? 'w-3 h-3' : size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2';

  return (
    <span className={`inline-flex items-center rounded border font-mono tabular-nums ${style.chip} ${sizeClass}`}>
      <span className={`rounded-full ${style.dot} ${dotSize}`} aria-hidden />
      <span>{score}</span>
      {showLabel && <span className="font-sans not-italic">{style.label}</span>}
      {confidence && size !== 'sm' && (
        <span className={`text-[10px] font-sans not-italic ${CONFIDENCE_STYLE[confidence]}`}>
          · {CONFIDENCE_LABEL[confidence]}
        </span>
      )}
    </span>
  );
}

interface GradeBadgeProps {
  grade: StockGrade;
  totalScore: number;
  /** 'sm' / 'md' / 'lg' */
  size?: 'sm' | 'md' | 'lg';
  showTagline?: boolean;
}

/** A-E 大 badge — StockGradeSummary 主標題 / MultiAgentTopPanel 列表用 */
export function GradeBadge({ grade, totalScore, size = 'md', showTagline = false }: GradeBadgeProps) {
  const style = GRADE_STYLE[grade];
  const sizeClass =
    size === 'lg' ? 'text-3xl px-4 py-2'
    : size === 'sm' ? 'text-xs px-1.5 py-0.5'
    : 'text-base px-2.5 py-1';

  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-flex items-center gap-1.5 rounded border font-bold ${style.bg} ${style.text} ${style.border} ${sizeClass}`}>
        <span className="font-mono">{grade}</span>
        <span className="font-mono tabular-nums opacity-80 text-[0.75em]">{totalScore}</span>
      </span>
      {showTagline && (
        <span className={`text-xs ${style.text} opacity-90`}>{style.tagline}</span>
      )}
    </span>
  );
}

/** 「未評分」灰色 badge — 舊資料 fallback */
export function UnscoredBadge({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass =
    size === 'lg' ? 'text-base px-3 py-1.5'
    : size === 'sm' ? 'text-[10px] px-1.5 py-0.5'
    : 'text-xs px-2 py-1';
  return (
    <span className={`inline-flex items-center gap-1 rounded border bg-slate-700/40 text-slate-400 border-slate-500/40 ${sizeClass}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
      <span>未評分</span>
    </span>
  );
}
