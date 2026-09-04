'use client';

/**
 * /health → 行情 tab
 *
 * 原本 /health 整頁的內容：L1 歷史 K / L2 盤中快照 / L4 掃描結果（台股 + 陸股 雙卡）。
 * Stage 3 拆出當 tab，邏輯 1:1 維持。
 */

import { useEffect, useState } from 'react';

interface MarketHealthLite {
  ok: boolean;
  market: 'TW' | 'CN';
  health: string;
  reportDate: string | null;
  coverageRate: number | null;
  stocksNoTrade: number | null;
  stocksNotTrading: number | null;
  stocksWithGaps: number | null;
  stocksStale: number | null;
  downloadFailed: number | null;
  downloadAttemptsFailed: number | null;
  l2: { status: string; quoteCount: number | null; ageSeconds: number | null; updatedAt: string | null };
  l2Sources?: { alertLevel: string; consecutiveEmptyCount: number; isTradingDay: boolean };
  l4?: { status: string; lastScanDate: string | null; lastScanCount: number; lastScanTime: string | null; todayHasIntraday: boolean };
  limitUpConsistency?: { level: string; suspicious: number };
  l1l2Consistency?: { level: string; diff1pct: number; diff5pct: number; total: number; reason?: string; snapshotUpdatedAt?: string };
  strategyReadiness?: { status: string; readyCount: number; requiredCount: number; missing: string[]; invalid: string[] };
}

interface DependencyHealth {
  finMindBranch: { kind: 'unknown' | 'ok' | 'permission_denied' | 'rate_limited' | 'unavailable'; message: string; checkedAt: string | null };
  chipCoverage: {
    date: string;
    poolSize: number;
    institutional: { count: number; coverage: number };
    broker: { count: number; coverage: number };
    concentration: {
      mode: 'exact' | 'approximate'; count: number; coverage: number; label: string;
      window5d: { count: number; coverage: number };
      window20d: { count: number; coverage: number };
    };
    level: 'green' | 'yellow' | 'red';
  };
  yTrackReadiness?: {
    date: string;
    mode: 'finmind_exact' | 'yahoo_daily_approximate';
    tradedPool: number;
    institutionalCurrent: { count: number; coverage: number };
    brokerCurrent: { count: number; coverage: number };
    strategyWindow: { count: number; coverage: number; requiredDays: number };
    ready: boolean;
    reasons: string[];
  };
  paperTrack: { level: 'ok' | 'warning' | 'stale' | 'missing'; ageDays: number | null; message: string; updatedAt: string | null };
  dataSourceResilience: { total: number; protected: number; degraded: number; unprotected: number };
}

type LightLevel = 'green' | 'yellow' | 'red';

function deriveMarketLight(m: MarketHealthLite | null): LightLevel {
  if (!m || !m.ok) return 'red';
  if (m.health === 'critical' || m.health === 'no_report') return 'red';
  if (m.coverageRate != null && m.coverageRate < 0.90) return 'red';
  if ((m.stocksStale ?? 0) > 200) return 'red';
  if (m.l2Sources?.alertLevel === 'critical') return 'red';
  if (m.l4?.status !== 'fresh') return 'red';
  if (m.strategyReadiness && m.strategyReadiness.status !== 'ready') return 'red';
  if (m.limitUpConsistency?.level === 'critical') return 'red';
  if (m.l1l2Consistency?.level === 'critical') return 'red';

  if (m.health === 'warning') return 'yellow';
  if (m.coverageRate != null && m.coverageRate < 0.97) return 'yellow';
  if ((m.stocksStale ?? 0) > 50) return 'yellow';
  if (m.l2Sources?.alertLevel === 'warning') return 'yellow';
  if (m.limitUpConsistency?.level === 'warning') return 'yellow';
  if (m.l1l2Consistency?.level === 'warning' || m.l1l2Consistency?.level === 'unavailable') return 'yellow';

  return 'green';
}

function deriveOverallLight(markets: (MarketHealthLite | null)[], dependencies: DependencyHealth | null): LightLevel {
  const lights = markets.map(deriveMarketLight);
  if (dependencies) {
    // 精確全分點失效時仍有 Yahoo 估算＋本地快取，屬降級而非整體資料中斷。
    if (dependencies.finMindBranch.kind === 'permission_denied' || dependencies.finMindBranch.kind === 'unavailable') lights.push('yellow');
    else if (dependencies.finMindBranch.kind !== 'ok') lights.push('yellow');
    lights.push(dependencies.chipCoverage.level);
    if (!dependencies.yTrackReadiness?.ready) lights.push('red');
    else if (dependencies.yTrackReadiness.mode === 'yahoo_daily_approximate'
      || dependencies.yTrackReadiness.strategyWindow.coverage < 1) lights.push('yellow');
    if (dependencies.dataSourceResilience.unprotected > 0) lights.push('red');
    else if (dependencies.dataSourceResilience.degraded > 0) lights.push('yellow');
    if (dependencies.paperTrack.level === 'stale' || dependencies.paperTrack.level === 'missing') lights.push('red');
    else if (dependencies.paperTrack.level === 'warning') lights.push('yellow');
  }
  if (lights.includes('red')) return 'red';
  if (lights.includes('yellow')) return 'yellow';
  return 'green';
}

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
  } catch { return '—'; }
}

/** 今天（CST）是否為週末。國定假日暫不判斷（需 holiday calendar）。 */
function isWeekendOrHoliday(): boolean {
  const cst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const dow = cst.getDay();
  return dow === 0 || dow === 6;
}

export function MarketDataTab() {
  const [tw, setTw] = useState<MarketHealthLite | null>(null);
  const [cn, setCn] = useState<MarketHealthLite | null>(null);
  const [dependencies, setDependencies] = useState<DependencyHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAll = async () => {
      setFetchError(null);
      const [twResult, cnResult, depResult] = await Promise.allSettled([
        fetch('/api/health/data?market=TW').then(r => r.json()),
        fetch('/api/health/data?market=CN').then(r => r.json()),
        fetch('/api/health/dependencies', { signal: AbortSignal.timeout(25_000) }).then(r => r.json()),
      ]);
      const failures: string[] = [];
      if (twResult.status === 'fulfilled' && twResult.value.ok) setTw(twResult.value as MarketHealthLite);
      else failures.push('台股健康資料');
      if (cnResult.status === 'fulfilled' && cnResult.value.ok) setCn(cnResult.value as MarketHealthLite);
      else failures.push('陸股健康資料');
      if (depResult.status === 'fulfilled' && depResult.value.ok && depResult.value.dependencies) {
        setDependencies(depResult.value.dependencies as DependencyHealth);
      } else failures.push('外部資料／排程檢查');
      if (failures.length) setFetchError(`${failures.join('、')}讀取失敗`);
      setLoading(false);
    };
    fetchAll();
    const t = setInterval(fetchAll, 60_000);
    return () => clearInterval(t);
  }, []);

  const overall = deriveOverallLight([tw, cn], dependencies);
  const lightConfig: Record<LightLevel, { bg: string; text: string; emoji: string; label: string; tip: string }> = {
    green: {
      bg: 'bg-green-950/60 border-green-700',
      text: 'text-green-300',
      emoji: '✓',
      label: '正常',
      tip: '資料完整、掃描正常運作。',
    },
    yellow: {
      bg: 'bg-yellow-950/60 border-yellow-700',
      text: 'text-yellow-300',
      emoji: '!',
      label: '部分異常',
      tip: '有股票資料落後或 L2 警告，系統會自動修復。請於下方看是哪個市場有問題。',
    },
    red: {
      bg: 'bg-red-950/60 border-red-700',
      text: 'text-red-300',
      emoji: '✗',
      label: '需要處理',
      tip: '今日資料不完整或邏輯異常。請依下方提示動手或聯繫維護。',
    },
  };
  const cfg = lightConfig[overall];

  return (
    <div className="space-y-6">
      {/* 總體紅綠燈 */}
      <div className={`rounded-lg border p-6 ${cfg.bg}`}>
        <div className="flex items-center gap-4">
          <div className={`text-5xl font-bold ${cfg.text}`}>{cfg.emoji}</div>
          <div className="flex-1">
            <div className={`text-2xl font-semibold ${cfg.text}`}>{cfg.label}</div>
            <div className="text-sm text-muted-foreground mt-1">{cfg.tip}</div>
          </div>
        </div>
      </div>

      {loading && !tw && !cn && (
        <div role="status" className="text-center py-12 text-muted-foreground">載入健康資料中…</div>
      )}
      {fetchError && <div role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">部分健康檢查失敗：{fetchError}</div>}

      {/* 兩市場詳情 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MarketCard market="TW" data={tw} />
        <MarketCard market="CN" data={cn} />
      </div>

      <section className="space-y-2" aria-labelledby="runtime-dependencies-title">
        <h2 id="runtime-dependencies-title" className="text-sm font-semibold">外部資料與自動追蹤</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <DependencyCard
            title="FinMind 主力分點"
            level={dependencies?.finMindBranch.kind === 'ok' ? 'green' : 'yellow'}
            message={dependencies?.finMindBranch.message ?? '尚未完成檢查'}
            detail="精確源失效時使用獨立標示的 Yahoo 每日前15大近似模式；只在完整10日窗達標時評估訊號"
          />
          <DependencyCard
            title="籌碼前 500 可交易股覆蓋"
            level={dependencies?.chipCoverage.level ?? 'red'}
            message={dependencies?.chipCoverage
              ? `法人 ${fmtPct(dependencies.chipCoverage.institutional.coverage)} · 主力 ${fmtPct(dependencies.chipCoverage.broker.coverage)}`
              : '尚未完成檢查'}
            detail={dependencies?.chipCoverage
              ? `${dependencies.chipCoverage.date}；${dependencies.chipCoverage.concentration.label}：當日 ${fmtPct(dependencies.chipCoverage.concentration.coverage)}、5日 ${fmtPct(dependencies.chipCoverage.concentration.window5d.coverage)}、20日 ${fmtPct(dependencies.chipCoverage.concentration.window20d.coverage)}；Y軌完整10日窗 ${fmtPct(dependencies.yTrackReadiness?.strategyWindow.coverage ?? null)}`
              : '檢查成交額前 500 的逐股法人與主力分點'}
          />
          <DependencyCard
            title="Paper-trade 每日追蹤"
            level={dependencies?.paperTrack.level === 'ok' ? 'green' : dependencies?.paperTrack.level === 'warning' ? 'yellow' : 'red'}
            message={dependencies?.paperTrack.message ?? '尚未完成檢查'}
            detail={dependencies?.paperTrack.updatedAt ? `最後更新 ${fmtTime(dependencies.paperTrack.updatedAt)}` : '沒有更新紀錄'}
          />
          <DependencyCard
            title="關鍵資料備援"
            level={(dependencies?.dataSourceResilience.unprotected ?? 1) > 0 ? 'red' : (dependencies?.dataSourceResilience.degraded ?? 1) > 0 ? 'yellow' : 'green'}
            message={dependencies?.dataSourceResilience
              ? `${dependencies.dataSourceResilience.protected} 項完整備援、${dependencies.dataSourceResilience.degraded} 項安全降級`
              : '尚未完成檢查'}
            detail={dependencies?.dataSourceResilience
              ? `共 ${dependencies.dataSourceResilience.total} 項關鍵資料；無備援 ${dependencies.dataSourceResilience.unprotected} 項`
              : '檢查每一項關鍵資料是否具備替代來源'}
          />
        </div>
      </section>

      {/* 操作提示 */}
      <div className="text-xs text-muted-foreground border-t border-border pt-3">
        <div className="font-medium mb-1">看到紅燈/黃燈怎麼辦？</div>
        <ul className="list-disc list-inside space-y-0.5 pl-2">
          <li>小問題（落後 1-50 支）：等下一輪 cron 自動修復</li>
          <li className="flex items-center gap-1.5 flex-wrap">
            大問題（覆蓋率 &lt; 90%）：
            <CopyCode cmd="npx tsx scripts/audit-l1-integrity.ts TW 7" />
          </li>
          <li className="flex items-center gap-1.5 flex-wrap">
            K 棒缺日：
            <CopyCode cmd="npx tsx scripts/insert-missing-day.ts TW 2026-MM-DD" />
          </li>
          <li>歷史快照：<code className="text-foreground">data/health-snapshot/health-YYYY-MM-DD.json</code> 看當天狀態</li>
        </ul>
      </div>
    </div>
  );
}

function CopyCode({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1 group">
      <code className="text-foreground select-all">{cmd}</code>
      <button
        type="button"
        onClick={async () => {
          try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
        }}
        aria-label={`複製指令 ${cmd}`}
        className="min-h-11 sm:min-h-8 opacity-50 hover:opacity-100 text-[10px] px-2 rounded hover:bg-secondary"
        title="複製"
      >
        {copied ? '✓' : '📋'}
      </button>
    </span>
  );
}

function DependencyCard({ title, level, message, detail }: { title: string; level: LightLevel; message: string; detail: string }) {
  const tone = level === 'green'
    ? 'border-green-700/50 bg-green-950/30 text-green-300'
    : level === 'yellow'
      ? 'border-yellow-700/50 bg-yellow-950/30 text-yellow-300'
      : 'border-red-700/50 bg-red-950/30 text-red-300';
  return (
    <div role={level === 'red' ? 'alert' : 'status'} className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex items-center gap-2 font-semibold"><span className="size-2.5 rounded-full bg-current" aria-hidden="true" />{title}</div>
      <div className="mt-2 text-sm">{message}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div>
    </div>
  );
}

function MarketCard({ market, data }: { market: 'TW' | 'CN'; data: MarketHealthLite | null }) {
  const light = deriveMarketLight(data);
  const cfg: Record<LightLevel, { dot: string; label: string }> = {
    green: { dot: 'bg-green-500', label: '正常' },
    yellow: { dot: 'bg-yellow-500', label: '部分異常' },
    red: { dot: 'bg-red-500', label: '需要處理' },
  };

  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${cfg[light].dot}`} />
          <span className="font-bold text-lg">{market === 'TW' ? '台股' : '陸股'}</span>
        </div>
        <span className="text-xs text-muted-foreground">{cfg[light].label}</span>
      </div>

      {!data && <div className="text-xs text-muted-foreground">無資料</div>}

      {data && (
        <>
          {/* L1 歷史K */}
          <Section title="歷史日K（每日盤後封存）">
            <Row label="健康度" value={zhStatus(data.health)} bold
              hint="健康度 = 覆蓋率 + 近 3 日落後支數綜合判定；歷史 gap（容忍範圍內缺日）不會把健康度拉到非正常" />
            <Row label="覆蓋率" value={fmtPct(data.coverageRate)}
              hint="今日有 K 線資料的股票數 / 今日實際交易股票數；已確認停牌、無成交或尚未開始交易者不列入分母" />
            <Row label="停牌／當日無成交" value={`${data.stocksNoTrade ?? 0} 支`}
              hint="最終全市場快照已確認成交量為 0，因此不偽造平盤日 K，也不算資料落後" />
            <Row label="停止／尚未開始交易" value={`${data.stocksNotTrading ?? 0} 支`}
              hint="包含停止買賣、終止上市流程或代碼已進清單但尚未開始交易者；沒有真實當日 K 棒，不列入活躍股票覆蓋率" />
            <Row label="近 3 日落後" value={`${data.stocksStale ?? '?'} 支`}
              warn={(data.stocksStale ?? 0) > 50}
              hint="近 3 日該收盤但未封存的股票數；> 50 觸發黃燈，> 100 觸發紅燈並 webhook" />
            <Row label="未解決讀取失敗" value={`${data.downloadFailed ?? 0} 支`}
              warn={(data.downloadFailed ?? 0) > 0}
              hint={`校驗後仍無法讀取的股票數；本輪曾失敗但已由其他來源補齊的嘗試共 ${data.downloadAttemptsFailed ?? 0} 次`} />
            <Row label="歷史 gap" value={`${data.stocksWithGaps ?? '?'} 支`}
              hint="歷史 K 線中間出現缺日（例如停牌、缺資料）的股票數；在容忍範圍內不影響「健康度」，但建議跑 audit-l1-integrity 確認" />
            <Row label="校驗時間" value={fmtTime(data.reportDate ? `${data.reportDate}T00:00:00Z` : null)} muted
              hint="最近一次 L1 audit cron 跑完的時間；audit 默認 09:00 CST 跑一次，會落後於盤後封存約 1 天" />
          </Section>

          {/* L2 盤中快照 */}
          <Section title="盤中快照（全市場即時報價）">
            <Row label="狀態" value={zhStatus(data.l2.status)} bold />
            <Row label="筆數" value={`${data.l2.quoteCount ?? 0} 筆`} />
            <Row label="更新時間" value={fmtTime(data.l2.updatedAt)} muted />
            {data.l2Sources?.alertLevel && data.l2Sources.alertLevel !== 'none' && (
              <Row label="告警" value={data.l2Sources.alertLevel} warn />
            )}
          </Section>

          {/* L4 掃描 */}
          <Section title="掃描結果（盤後策略掃描）">
            <Row label="狀態" value={zhStatus(data.l4?.status ?? '—')} bold />
            <Row label="最近掃描" value={`${data.l4?.lastScanDate ?? '—'} (${data.l4?.lastScanCount ?? 0} 檔)`} />
            <Row label="今日盤中" value={data.l4?.todayHasIntraday ? '有' : (isWeekendOrHoliday() ? '— 非交易日' : '無')}
              warn={data.l4 != null && !data.l4.todayHasIntraday && !isWeekendOrHoliday()}
              hint="今日盤中時段（09:00-13:30 CST）是否有產生 intraday 掃描；週末/國定假日為非交易日，顯示「—」屬正常" />
          </Section>

          <Section title="跨層資料一致性">
            <Row
              label="L1 ↔ L2 收盤價"
              value={zhStatus(data.l1l2Consistency?.level ?? 'unavailable')}
              bold
              warn={data.l1l2Consistency?.level === 'warning' || data.l1l2Consistency?.level === 'unavailable'}
              hint={data.l1l2Consistency?.reason ?? '以同一交易日收盤後的 L2 最終快照，抽樣比對 L1 日 K 收盤價'}
            />
            <Row label="偏差 > 1%" value={`${data.l1l2Consistency?.diff1pct ?? 0} / ${data.l1l2Consistency?.total ?? 0} 檔`} />
            <Row label="漲停價一致性" value={zhStatus(data.limitUpConsistency?.level ?? 'unknown')}
              warn={data.limitUpConsistency?.level === 'warning'} />
            <Row label="正式策略" value={zhStatus(data.strategyReadiness?.status ?? 'unknown')}
              warn={data.strategyReadiness != null && data.strategyReadiness.status !== 'ready'} />
          </Section>
        </>
      )}
    </div>
  );
}

/** 健康/快照狀態英文 → 中文 */
function zhStatus(s: string): string {
  const map: Record<string, string> = {
    good: '正常',
    ok: '正常',
    fresh: '最新',
    stale: '過期',
    warning: '警告',
    error: '錯誤',
    none: '無',
    unknown: '未知',
    missing: '無快照',
    'pre-market': '盤前（前一交易日）',
    unavailable: '資料不足',
    critical: '嚴重異常',
    ready: '已就緒',
    partial: '不完整',
  };
  return map[s?.toLowerCase()] ?? s;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-2">
      <div className="text-xs font-medium text-foreground mb-1">{title}</div>
      <div className="space-y-0.5 text-xs">{children}</div>
    </div>
  );
}

function Row({ label, value, bold, muted, warn, hint }: {
  label: string; value: string; bold?: boolean; muted?: boolean; warn?: boolean; hint?: string;
}) {
  const cls = warn ? 'text-yellow-400' : muted ? 'text-muted-foreground' : 'text-foreground';
  return (
    <div className="flex justify-between">
      <span className={`text-muted-foreground ${hint ? 'cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-4' : ''}`} title={hint}>{label}</span>
      <span className={`${cls} ${bold ? 'font-medium' : ''}`}>{value}</span>
    </div>
  );
}
