/**
 * StockGradeSummary — A-E 等級總結卡(取代 4 verdict 並列)
 *
 * 顯示:
 *   - 大 GradeBadge(A-E)+ 總分 + tagline(「優先觀察」「避開」等)
 *   - 適合操作類型 + 4 面分數小卡
 *   - 主要利多 / 主要風險(從 LLM 整合的 keyBullPoints / keyRiskPoints)
 *   - 最終判斷(decision.verdictReason / overview)
 *   - 若 grade=C 顯示 nextConditionToWatch
 *
 * 舊資料 fallback:若無 gradeBlock,不顯示這個元件,改顯示 NeedsRescoreBanner。
 */

'use client';

import { GradeBadge, ScoreLightBadge } from './ScoreLightBadge';
import type { FinalDecision } from '@/lib/agents/types';
import type { ScoredAgentId, SuitableFor } from '@/lib/agents/scoringTypes';

const SUITABLE_LABEL: Record<SuitableFor, string> = {
  short_term: '短線(1-5 日)',
  swing: '波段(1-4 週)',
  long_term: '長線(1 季以上)',
  observe_only: '僅觀察',
  avoid: '避開',
};

const AGENT_LABEL: Record<ScoredAgentId, string> = {
  technical: '技術面',
  chip: '籌碼資金面',
  fundamental: '基本估值面',
  news: '消息題材面',
};

interface Props {
  decision: FinalDecision;
  symbol: string;
  name?: string | null;
  date: string;
}

export function StockGradeSummary({ decision, symbol, name, date }: Props) {
  const gb = decision.gradeBlock;
  if (!gb) return null;  // 由 caller 用 NeedsRescoreBanner 處理

  const scores = decision.scoresByAgent ?? {};
  const bull = decision.keyBullPoints ?? [];
  const risks = decision.keyRiskPoints ?? [];

  return (
    <section className="rounded-lg border border-slate-700/60 bg-gradient-to-br from-slate-900 to-slate-900/70 p-5 space-y-4">
      {/* 頂部 meta */}
      <div className="flex items-start justify-between flex-wrap gap-2 text-xs">
        <div className="space-y-0.5">
          <p className="text-muted-foreground">綜合評估</p>
          <h2 className="text-base font-medium text-foreground">
            {name ?? '—'} <span className="font-mono text-muted-foreground">{symbol}</span>
          </h2>
        </div>
        <p className="text-muted-foreground tabular-nums">分析日期:{date}</p>
      </div>

      {/* Grade 中央顯示 */}
      <div className="flex flex-col items-center gap-2 py-3">
        <GradeBadge grade={gb.grade} totalScore={gb.totalScore} size="lg" />
        <p className="text-sm text-foreground/90 text-center max-w-md">{gb.gradeReason}</p>
        <p className="text-xs text-muted-foreground">
          適合操作:<span className="text-foreground/80">{SUITABLE_LABEL[gb.suitableFor]}</span>
        </p>
      </div>

      {/* 4 面分數小卡 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {(['technical', 'chip', 'fundamental', 'news'] as const).map((id) => {
          const s = scores[id];
          return (
            <div
              key={id}
              className="border border-slate-700/40 rounded p-2 bg-slate-800/40 space-y-1"
            >
              <p className="text-[10px] text-muted-foreground">{AGENT_LABEL[id]}</p>
              {s ? (
                <ScoreLightBadge
                  score={s.score}
                  light={s.light as never}
                  confidence={s.confidence as never}
                  size="md"
                  showLabel
                />
              ) : (
                <span className="text-xs text-muted-foreground italic">未評</span>
              )}
            </div>
          );
        })}
      </div>

      {/* 主要利多 / 主要風險 */}
      {(bull.length > 0 || risks.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-800">
          <div>
            <p className="text-xs font-medium text-green-300 mb-1">主要利多</p>
            {bull.length > 0 ? (
              <ul className="space-y-1 text-xs text-foreground/85 list-disc pl-4">
                {bull.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground italic">無</p>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-red-300 mb-1">主要風險</p>
            {risks.length > 0 ? (
              <ul className="space-y-1 text-xs text-foreground/85 list-disc pl-4">
                {risks.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground italic">無</p>
            )}
          </div>
        </div>
      )}

      {/* 最終判斷 */}
      <div className="pt-2 border-t border-slate-800 space-y-1">
        <p className="text-xs font-medium text-sky-300">最終判斷</p>
        <p className="text-sm text-foreground/90">{decision.overview}</p>
        {decision.verdictReason && (
          <p className="text-xs text-muted-foreground">{decision.verdictReason}</p>
        )}
      </div>

      {/* C 級才顯示 nextConditionToWatch */}
      {decision.nextConditionToWatch && (
        <div className="rounded border border-sky-500/40 bg-sky-700/20 text-sky-200 px-3 py-2 text-xs space-y-1">
          <p className="font-medium">⏳ 下一個要確認的條件</p>
          <p className="text-sky-200/90">{decision.nextConditionToWatch}</p>
        </div>
      )}

      {/* 衝突區塊 */}
      {decision.conflicts.length > 0 && (
        <div className="rounded border border-amber-500/30 bg-amber-700/10 text-amber-200 px-3 py-2 text-xs space-y-0.5">
          <p className="font-medium">面向衝突</p>
          <ul className="list-disc pl-4 text-amber-200/85">
            {decision.conflicts.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
