'use client';

/**
 * 系統任務 tab — 顯示 /api/health/pipeline 的內部 API 自我檢測結果。
 *
 * 為什麼存在：2026-05-24 發現 dev server port 3000 在 /api/stock 早就 500
 * 但沒人發現，直到 youtube-prepare-analysis 的 bundle 全 fail。這個 tab 至少
 * 讓資料健康頁能即時亮紅燈。
 */

import { useEffect, useState } from 'react';

interface Check { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; }
interface PipelineResp {
  ok: boolean;
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: Check[];
}

const STATUS_DOT: Record<Check['status'], string> = {
  ok:   'bg-green-500',
  warn: 'bg-yellow-500',
  fail: 'bg-red-500',
};
const OVERALL_BADGE: Record<PipelineResp['status'], string> = {
  healthy:   'bg-green-900/40 text-green-300 border-green-600',
  degraded:  'bg-yellow-900/40 text-yellow-300 border-yellow-600',
  unhealthy: 'bg-red-900/40 text-red-300 border-red-600',
};
const OVERALL_LABEL: Record<PipelineResp['status'], string> = {
  healthy:   '✅ 正常',
  degraded:  '⚠️ 部分異常',
  unhealthy: '❌ 嚴重異常',
};

export function SystemTab() {
  const [data, setData] = useState<PipelineResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const r = await fetch('/api/health/pipeline');
        const j = await r.json();
        setData(j as PipelineResp);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">資料管線健康</h2>
        {data && (
          <span className={`text-xs px-2 py-0.5 rounded border font-bold ${OVERALL_BADGE[data.status]}`}>
            {OVERALL_LABEL[data.status]}
          </span>
        )}
        {loading && <span className="text-xs text-sky-400 animate-pulse">載入中…</span>}
      </div>

      {error && (
        <div className="rounded border border-red-700/40 bg-red-950/30 text-red-300 text-sm p-3">
          {error}
        </div>
      )}

      {data && (
        <div className="rounded-xl ring-1 ring-foreground/10 bg-card divide-y divide-border/40">
          {data.checks.map((c, i) => (
            <div key={i} className="px-4 py-2.5 flex items-center gap-3 text-sm">
              <span className={`w-2 h-2 rounded-full ${STATUS_DOT[c.status]}`} />
              <span className="font-medium">{c.name}</span>
              <span className="text-muted-foreground text-xs ml-auto">{c.detail}</span>
            </div>
          ))}
        </div>
      )}

      {data && (
        <div className="text-[10px] text-muted-foreground/60 text-right">
          更新於 {new Date(data.timestamp).toLocaleTimeString('zh-TW', { hour12: false })}（每 60 秒）
        </div>
      )}
    </div>
  );
}
