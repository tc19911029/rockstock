'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, Calculator, RefreshCw } from 'lucide-react';
import { PageHeader, PageShell, Panel } from '@/components/shared';
import {
  LARGE_DIFF_RATIO_THRESHOLD,
  LARGE_TRADE_RATIO_THRESHOLD,
  type SmartMoneyRotationPoint,
  type SmartMoneyRotationZone,
} from '@/lib/smartmoney/rotation';

interface RotationResponse {
  ok?: boolean;
  error?: string;
  points: SmartMoneyRotationPoint[];
  requestedCodes: string[];
  missingCodes: string[];
  dates: string[];
  source: string;
  caveat: string;
}

const DEFAULT_CODES = '5475, 8046, 6187, 2467, 6584, 4576, 3044, 2408';

const ZONES: Record<SmartMoneyRotationZone, {
  title: string;
  subtitle: string;
  point: string;
  badge: string;
}> = {
  leading: {
    title: '領先區', subtitle: '強勢主流', point: '#22c55e',
    badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  },
  improving: {
    title: '改善區', subtitle: '籌碼改善中', point: '#38bdf8',
    badge: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  },
  weakening: {
    title: '弱化區', subtitle: '資金退潮', point: '#f97316',
    badge: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  },
  lagging: {
    title: '落後區', subtitle: '弱勢觀望', point: '#94a3b8',
    badge: 'border-border bg-muted text-muted-foreground',
  },
};

function pct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function RotationChart({ points }: { points: SmartMoneyRotationPoint[] }) {
  const width = 1000;
  const height = 640;
  const margin = { left: 76, right: 28, top: 70, bottom: 66 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const rawMin = points.length ? Math.min(...points.map((point) => point.largeDiffRatio)) : 0;
  const rawMax = points.length ? Math.max(...points.map((point) => point.largeDiffRatio)) : 40;
  const yMin = Math.min(0, Math.floor(rawMin / 10) * 10);
  const yMax = Math.max(50, Math.ceil(rawMax / 10) * 10);
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const xPos = (value: number) => margin.left + (clamp(value, 0, 100) / 100) * plotWidth;
  const yPos = (value: number) => margin.top + ((yMax - clamp(value, yMin, yMax)) / (yMax - yMin)) * plotHeight;
  const thresholdX = xPos(LARGE_TRADE_RATIO_THRESHOLD);
  const thresholdY = yPos(LARGE_DIFF_RATIO_THRESHOLD);
  const yTicks = Array.from(
    { length: Math.floor((yMax - yMin) / 10) + 1 },
    (_, index) => yMin + index * 10,
  );
  const geometry = points.map((point, index) => ({
    point,
    index,
    x: xPos(point.largeTradeRatio),
    y: yPos(point.largeDiffRatio),
  }));
  const labels = new Map<string, { x: number; y: number; anchor: 'start' | 'end' }>();

  // 密集個股分到圓點左右兩側，再以最小間距排開，避免文字互相覆蓋。
  for (const side of ['left', 'right'] as const) {
    const group = geometry
      .filter(({ x }) => side === 'left' ? x >= xPos(82) : x < xPos(82))
      .sort((a, b) => a.y - b.y);
    const minY = margin.top + 48;
    const maxY = height - margin.bottom - 48;
    const gap = 29;
    const placed = group.map(({ y }) => clamp(y, minY, maxY));

    for (let index = 1; index < placed.length; index++) {
      placed[index] = Math.max(placed[index], placed[index - 1] + gap);
    }
    if (placed.length && placed[placed.length - 1] > maxY) {
      const shift = placed[placed.length - 1] - maxY;
      for (let index = 0; index < placed.length; index++) placed[index] -= shift;
    }
    for (let index = placed.length - 2; index >= 0; index--) {
      placed[index] = Math.min(placed[index], placed[index + 1] - gap);
    }

    group.forEach(({ point, x }, index) => {
      labels.set(point.code, {
        x: x + (side === 'left' ? -27 : 27),
        y: placed[index],
        anchor: side === 'left' ? 'end' : 'start',
      });
    });
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full min-h-[360px]"
        role="img"
        aria-labelledby="rotation-chart-title rotation-chart-description"
      >
        <title id="rotation-chart-title">大戶籌碼個股輪動四象限圖</title>
        <desc id="rotation-chart-description">
          橫軸為大戶買賣比，70% 為分界；縱軸為大戶差比，20% 為分界。圖下方另有完整數值表。
        </desc>

        <rect x={margin.left} y={margin.top} width={thresholdX - margin.left} height={thresholdY - margin.top} fill="#0c4a6e" opacity="0.34" />
        <rect x={thresholdX} y={margin.top} width={width - margin.right - thresholdX} height={thresholdY - margin.top} fill="#14532d" opacity="0.42" />
        <rect x={margin.left} y={thresholdY} width={thresholdX - margin.left} height={height - margin.bottom - thresholdY} fill="#334155" opacity="0.32" />
        <rect x={thresholdX} y={thresholdY} width={width - margin.right - thresholdX} height={height - margin.bottom - thresholdY} fill="#7c2d12" opacity="0.30" />

        {Array.from({ length: 6 }, (_, index) => index * 20).map((tick) => (
          <g key={`x-${tick}`}>
            <line x1={xPos(tick)} x2={xPos(tick)} y1={margin.top} y2={height - margin.bottom} stroke="#334155" strokeWidth="1" />
            <text x={xPos(tick)} y={height - margin.bottom + 28} fill="#94a3b8" textAnchor="middle" fontSize="15">{tick}%</text>
          </g>
        ))}
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line x1={margin.left} x2={width - margin.right} y1={yPos(tick)} y2={yPos(tick)} stroke="#334155" strokeWidth="1" />
            <text x={margin.left - 14} y={yPos(tick) + 5} fill="#94a3b8" textAnchor="end" fontSize="15">{tick}%</text>
          </g>
        ))}

        <line x1={thresholdX} x2={thresholdX} y1={margin.top} y2={height - margin.bottom} stroke="#facc15" strokeWidth="2.5" strokeDasharray="9 8" />
        <line x1={margin.left} x2={width - margin.right} y1={thresholdY} y2={thresholdY} stroke="#facc15" strokeWidth="2.5" strokeDasharray="9 8" />

        <text x={(margin.left + thresholdX) / 2} y={margin.top + 28} fill="#7dd3fc" textAnchor="middle" fontSize="22" fontWeight="700">改善區 · 籌碼改善中</text>
        <text x={(thresholdX + width - margin.right) / 2} y={margin.top + 28} fill="#86efac" textAnchor="middle" fontSize="22" fontWeight="700">領先區 · 強勢主流</text>
        <text x={(margin.left + thresholdX) / 2} y={height - margin.bottom - 18} fill="#cbd5e1" textAnchor="middle" fontSize="22" fontWeight="700">落後區 · 弱勢觀望</text>
        <text x={(thresholdX + width - margin.right) / 2} y={height - margin.bottom - 18} fill="#fdba74" textAnchor="middle" fontSize="22" fontWeight="700">弱化區 · 資金退潮</text>

        {geometry.map(({ point, index, x, y }) => {
          const color = ZONES[point.zone].point;
          const label = labels.get(point.code) ?? { x: x + 27, y, anchor: 'start' as const };
          const leaderEndX = label.anchor === 'end' ? label.x + 6 : label.x - 6;
          return (
            <a
              key={point.code}
              href={`/?load=${point.code}.TW`}
              aria-label={`${point.name ?? '名稱待補'} ${point.code}，大戶買賣比 ${pct(point.largeTradeRatio)}，大戶差比 ${pct(point.largeDiffRatio)}`}
            >
              <g className="cursor-pointer outline-none">
                <title>{`${point.name ?? '名稱待補'} ${point.code} · ${pct(point.largeTradeRatio)}, ${pct(point.largeDiffRatio)}`}</title>
                <line className="hidden md:block" x1={x} y1={y} x2={leaderEndX} y2={label.y} stroke={color} strokeWidth="1.5" opacity="0.75" />
                <circle cx={x} cy={y} r="19" fill={color} stroke="#f8fafc" strokeWidth="2.5" />
                <text x={x} y={y + 6} textAnchor="middle" fill="#020617" fontSize="16" fontWeight="800">{index + 1}</text>
                <text className="hidden md:block" x={label.x} y={label.y + 5} textAnchor={label.anchor} fill="#f8fafc" fontSize="14" fontWeight="700" paintOrder="stroke" stroke="#020617" strokeWidth="4">
                  {point.name ?? '名稱待補'} · {point.code}
                </text>
              </g>
            </a>
          );
        })}

        <text x={margin.left + plotWidth / 2} y={height - 14} fill="#cbd5e1" textAnchor="middle" fontSize="17" fontWeight="600">大戶買賣比（%）· 主力參與程度</text>
        <text transform={`translate(22 ${margin.top + plotHeight / 2}) rotate(-90)`} fill="#cbd5e1" textAnchor="middle" fontSize="17" fontWeight="600">大戶差比（%）· 主力買超力道</text>
      </svg>
    </div>
  );
}

export default function SmartMoneyRotationPage() {
  const [input, setInput] = useState(DEFAULT_CODES);
  const [submittedCodes, setSubmittedCodes] = useState(DEFAULT_CODES);
  const [data, setData] = useState<RotationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/smartmoney/rotation?codes=${encodeURIComponent(submittedCodes)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as RotationResponse;
        if (!response.ok) throw new Error(body.error ?? '資料載入失敗');
        return body;
      })
      .then(setData)
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setError(reason instanceof Error ? reason.message : '資料載入失敗');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [submittedCodes]);

  const counts = useMemo(() => {
    const base: Record<SmartMoneyRotationZone, number> = { leading: 0, improving: 0, weakening: 0, lagging: 0 };
    for (const point of data?.points ?? []) base[point.zone]++;
    return base;
  }, [data]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmittedCodes(input);
  };

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="大戶籌碼個股輪動圖"
          subtitle={data?.dates.length ? `資料日 ${data.dates.join('、')}` : 'Yahoo 分點近似版'}
          backButton="/smartmoney"
        />
      }
    >
      <div className="space-y-4 px-3 py-4 sm:px-5">
        <Panel className="p-4">
          <form onSubmit={onSubmit} className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="min-w-0 flex-1">
              <label htmlFor="rotation-codes" className="mb-1.5 block text-sm font-medium">觀察股票代號</label>
              <input
                id="rotation-codes"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="例如：5475, 8046, 6187"
                className="min-h-11 w-full rounded-lg border border-border bg-secondary/60 px-3 text-base font-mono outline-none transition-colors focus:border-sky-500 focus:ring-2 focus:ring-sky-500/25"
              />
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">可輸入 1–20 檔，以逗號或空白分隔；Yahoo 分點通常在盤後更新。</p>
            </div>
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-sky-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`size-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
              重新計算
            </button>
          </form>
        </Panel>

        <div className="grid gap-3 lg:grid-cols-[1.25fr_1fr]">
          <Panel className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <Calculator className="size-5 text-sky-400" aria-hidden="true" />
              <h2 className="font-semibold">圖片公式</h2>
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="rounded-lg bg-secondary/50 p-3">
                <div className="mb-1 text-xs text-muted-foreground">橫軸 · 主力參與程度</div>
                <div className="font-mono leading-relaxed">大戶買賣比 ＝（大戶買進＋大戶賣出）÷ 總成交額</div>
              </div>
              <div className="rounded-lg bg-secondary/50 p-3">
                <div className="mb-1 text-xs text-muted-foreground">縱軸 · 主力買超力道</div>
                <div className="font-mono leading-relaxed">大戶差比 ＝（大戶買進－大戶賣出）÷ 總成交額</div>
              </div>
            </div>
          </Panel>

          <Panel className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-400" aria-hidden="true" />
              <h2 className="font-semibold">資料口徑</h2>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              目前以 Yahoo「前15大買方分點實際買進張數」與「前15大賣方分點實際賣出張數」近似。
              公式與分區完全照圖，但不是 XQ 逐筆大單／特大單成交金額，數值不可冒充 XQ 原值。
            </p>
          </Panel>
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div>
        )}

        {loading && !data && (
          <Panel className="min-h-[420px] animate-pulse p-6 motion-reduce:animate-none">
            <div className="h-full min-h-[370px] rounded-lg bg-secondary/50" />
          </Panel>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {(Object.keys(ZONES) as SmartMoneyRotationZone[]).map((zone) => (
                <div key={zone} className={`rounded-xl border px-3 py-2.5 ${ZONES[zone].badge}`}>
                  <div className="text-sm font-semibold">{ZONES[zone].title}</div>
                  <div className="mt-0.5 text-xs opacity-80">{ZONES[zone].subtitle} · {counts[zone]} 檔</div>
                </div>
              ))}
            </div>

            {data.points.length > 0 ? <RotationChart points={data.points} /> : (
              <Panel className="p-8 text-center text-sm text-muted-foreground">目前沒有可計算的 Yahoo 分點資料。</Panel>
            )}

            {data.missingCodes.length > 0 && (
              <p className="text-xs text-amber-300">未取得分點資料：{data.missingCodes.join('、')}</p>
            )}

            <Panel className="overflow-hidden">
              <div className="border-b border-border px-4 py-3">
                <h2 className="font-semibold">完整數值</h2>
                <p className="mt-1 text-xs text-muted-foreground">表格是圖表的無障礙替代，也方便核對公式與分區。</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead className="bg-secondary/50 text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 text-left font-medium">股票</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">大戶買進占比</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">大戶賣出占比</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">大戶買賣比</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">大戶差比</th>
                      <th scope="col" className="px-4 py-2.5 text-left font-medium">分區</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.points.map((point) => (
                      <tr key={point.code} className="transition-colors hover:bg-secondary/30">
                        <td className="px-4 py-3">
                          <Link href={`/?load=${point.code}.TW`} className="font-medium text-sky-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
                            {point.name ?? '名稱待補'} <span className="font-mono text-xs text-muted-foreground">{point.code}</span>
                          </Link>
                        </td>
                        <td className="px-3 py-3 text-right font-mono tabular-nums">{pct(point.largeBuyShare)}</td>
                        <td className="px-3 py-3 text-right font-mono tabular-nums">{pct(point.largeSellShare)}</td>
                        <td className="px-3 py-3 text-right font-mono font-semibold tabular-nums">{pct(point.largeTradeRatio)}</td>
                        <td className="px-3 py-3 text-right font-mono font-semibold tabular-nums">{pct(point.largeDiffRatio)}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-medium ${ZONES[point.zone].badge}`}>{ZONES[point.zone].title}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
              <div><b className="text-emerald-300">領先區：</b>買賣比 ≥70%，差比 ≥20%</div>
              <div><b className="text-sky-300">改善區：</b>買賣比 &lt;70%，差比 ≥20%</div>
              <div><b className="text-orange-300">弱化區：</b>買賣比 ≥70%，差比 &lt;20%</div>
              <div><b className="text-foreground">落後區：</b>買賣比 &lt;70%，差比 &lt;20%</div>
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}
