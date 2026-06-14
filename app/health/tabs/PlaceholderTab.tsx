'use client';

/**
 * 暫時占位 tab — 技術策略 / Agent / 系統任務 三個 tab 共用骨架。
 * Stage 3 先有 tab 結構，內容由後續 stage 補。
 */

interface PlaceholderTabProps {
  title: string;
  description: string;
  comingSoon: string[];
}

export function PlaceholderTab({ title, description, comingSoon }: PlaceholderTabProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-6 text-center space-y-2">
        <div className="text-4xl">🚧</div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">{description}</p>
      </div>

      <div className="rounded-xl ring-1 ring-foreground/10 bg-card/40 p-4">
        <div className="text-xs font-medium text-muted-foreground mb-2">將會顯示</div>
        <ul className="list-disc list-inside text-sm text-foreground/80 space-y-1">
          {comingSoon.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
