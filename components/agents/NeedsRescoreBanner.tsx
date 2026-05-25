/**
 * NeedsRescoreBanner — 舊資料(無 scoreBlock/gradeBlock)時顯示提示
 *
 * 邏輯:decision.json 存在但 gradeBlock 缺,代表舊 4-phase 跑過但沒有 v1 評分。
 *      需使用者重跑 /multi-agent-decide skill 才會自動 enrich。
 */

interface Props {
  date: string;
  symbol?: string;
  /** 'top' = [symbol] 頁頂部 banner / 'inline' = MultiAgentTopPanel 列表內小條 */
  variant?: 'top' | 'inline';
}

export function NeedsRescoreBanner({ date, symbol, variant = 'top' }: Props) {
  if (variant === 'inline') {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] bg-amber-700/30 text-amber-200 border-amber-500/40"
        title={`${symbol ?? ''} 這筆 decision 是舊版,需重跑 multi-agent-decide 才有 0-100 評分 + A-E grade`}
      >
        <span>⟳</span>
        <span>需重跑</span>
      </span>
    );
  }

  return (
    <div className="rounded border border-amber-500/40 bg-amber-700/20 text-amber-200 px-3 py-2 text-xs space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-base">⟳</span>
        <span className="font-medium">此分析為舊版,沒有 0-100 評分與 A-E grade</span>
      </div>
      <div className="text-amber-200/80 leading-relaxed">
        4-phase verdict 仍可參考,但若想取得新版評分,請開 Claude Code 對話跑{' '}
        <code className="bg-black/30 px-1 py-0.5 rounded text-amber-100">/multi-agent-decide</code>
        {' '}重跑 {date}
        {symbol ? <> 的 <span className="font-mono">{symbol}</span></> : <> 的這檔股票</>}。新評分會自動覆蓋寫入。
      </div>
    </div>
  );
}
