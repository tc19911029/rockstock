/**
 * AgentScorePanel — 4 大面向通用評分卡片
 *
 * 顯示:
 *   - 標題(中文)+ ScoreLightBadge(分數 + 燈號 + 信心)+ Verdict badge
 *   - overview / verdictReason
 *   - signals 列表(label + raw value + direction icon + 個別分數)
 *   - dataStatus.missing 提示
 *   - extraSlot:給 Chip 嵌入 TrustMomentumPanel
 *
 * 舊資料 fallback(無 scoreBlock):只顯示 verdict + overview,不顯示分數區。
 */

'use client';

import { type ReactNode, useState } from 'react';
import { ScoreLightBadge, UnscoredBadge, lightStyle } from './ScoreLightBadge';
import { SIGNAL_SPECS_BY_AGENT } from '@/lib/agents/scoring';
import type {
  AgentScoreBlock,
  ScoredAgentId,
  SignalSpec,
  SignalValue,
} from '@/lib/agents/scoringTypes';

interface AnswerLike {
  verdict?: 'pass' | 'watch' | 'fail';
  overview?: string;
  verdictReason?: string;
  caveat?: string;
  scoreBlock?: AgentScoreBlock;
}

interface Props {
  agentId: ScoredAgentId;
  /** 中文 agent 名稱(如「技術面 Agent」「籌碼資金面 Agent」)*/
  title: string;
  /** 副標(如「朱家泓技術分析 + 林穎 SOP」)*/
  subtitle?: string;
  answer: AnswerLike | null;
  /** Chip agent 專用:額外 sub-section(放 TrustMomentumPanel) */
  extraSlot?: ReactNode;
  /** 額外 footer 內容(若 caller 需要嵌入別的 panel)*/
  footerSlot?: ReactNode;
}

const VERDICT_STYLE: Record<'pass' | 'watch' | 'fail', { bg: string; text: string; label: string }> = {
  pass:  { bg: 'bg-green-700/40  border-green-500/60',  text: 'text-green-200',  label: 'pass'  },
  watch: { bg: 'bg-yellow-700/40 border-yellow-500/60', text: 'text-yellow-200', label: 'watch' },
  fail:  { bg: 'bg-red-700/40    border-red-500/60',    text: 'text-red-200',    label: 'fail'  },
};

export function AgentScorePanel({ agentId, title, subtitle, answer, extraSlot, footerSlot }: Props) {
  const [expandSignals, setExpandSignals] = useState(true);
  const score = answer?.scoreBlock;
  const specs = SIGNAL_SPECS_BY_AGENT[agentId];

  return (
    <section
      className={`rounded-lg border bg-slate-900 p-4 space-y-3 ${
        score ? `border-l-4 ${lightStyle(score.light).chip}` : 'border-slate-700/60'
      }`}
    >
      {/* 標題列 */}
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold tracking-wide text-foreground">{title}</h3>
          {subtitle && <p className="text-[10px] text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {score ? (
            <ScoreLightBadge
              score={score.score}
              light={score.light}
              confidence={score.confidence}
              size="md"
              showLabel
            />
          ) : (
            <UnscoredBadge size="md" />
          )}
          {answer?.verdict && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${VERDICT_STYLE[answer.verdict].bg} ${VERDICT_STYLE[answer.verdict].text}`}>
              {VERDICT_STYLE[answer.verdict].label}
            </span>
          )}
        </div>
      </header>

      {/* 結論摘要 */}
      {answer && (
        <div className="space-y-1 text-xs">
          {answer.overview && <p className="text-foreground/90">{answer.overview}</p>}
          {answer.verdictReason && <p className="text-muted-foreground">{answer.verdictReason}</p>}
          {answer.caveat && (
            <p className="text-amber-300/80 italic">⚠ {answer.caveat}</p>
          )}
        </div>
      )}

      {/* signals 列表 */}
      {score && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setExpandSignals((s) => !s)}
            className="text-[10px] text-sky-400 hover:underline"
          >
            {expandSignals ? '▾' : '▸'} 評分細項({specs.length} 個 signal)
          </button>
          {expandSignals && (
            <ul className="divide-y divide-slate-800 border border-slate-800 rounded text-xs">
              {specs.map((spec) => (
                <SignalRow key={spec.key} spec={spec} value={score.signals[spec.key]} />
              ))}
            </ul>
          )}
          {score.dataStatus.missing.length > 0 && (
            <p className="text-[10px] text-amber-400/70 italic">
              ⚠ {score.dataStatus.missing.length} 個 signal 無資料,已重新加權其他 signal(信心降為「{
                score.confidence === 'high' ? '高' : score.confidence === 'medium' ? '中' : '低'
              }」)
            </p>
          )}
        </div>
      )}

      {/* extra slot(Chip 放 TrustMomentumPanel)*/}
      {extraSlot}

      {/* footer slot */}
      {footerSlot}
    </section>
  );
}

function SignalRow({ spec, value }: { spec: SignalSpec; value: SignalValue | undefined }) {
  const missing = !value || value.value === null || value.value === undefined;
  const directionIcon =
    !value ? '—'
    : value.direction === 'bullish' ? '↗'
    : value.direction === 'bearish' ? '↘'
    : '→';
  const directionColor =
    !value ? 'text-muted-foreground'
    : value.direction === 'bullish' ? 'text-green-400'
    : value.direction === 'bearish' ? 'text-red-400'
    : 'text-slate-400';

  const displayValue =
    missing ? <span className="text-muted-foreground italic">資料不足</span>
    : <span className="font-mono tabular-nums">{String(value!.value)}</span>;

  return (
    <li className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 px-2 py-1.5">
      <span className={`text-base ${directionColor}`}>{directionIcon}</span>
      <span className="text-foreground/80">
        {spec.label}
        {spec.penalty && <span className="text-[9px] text-amber-400/60 ml-1">(扣分)</span>}
        {spec.core && <span className="text-[9px] text-sky-400/60 ml-1">(core)</span>}
      </span>
      <span className="text-right text-[11px]">{displayValue}</span>
      <span className="text-right font-mono tabular-nums text-[11px] text-muted-foreground min-w-[40px]">
        {missing ? '—' : `${value!.score}`}
      </span>
      {value?.note && (
        <span className="col-span-4 text-[10px] text-muted-foreground/80 pl-7 -mt-0.5">
          {value.note}
        </span>
      )}
    </li>
  );
}
