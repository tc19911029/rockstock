'use client';

/**
 * 走圖頁單支股票 Codex 分析（朱老師體系）— schemaVersion=3
 *
 * v3 設計：
 *   - 拔掉 v2 的 ABCDE 徽章 + 5 燈號 chip 列
 *   - 新增「📊 朱老師找到的數值（{N}筆）」折疊面板，按 category 分組顯示
 *   - 8 段 reasoning 折疊，每段強制含 ≥ 2 個具體數字（由 zhu.md skill 規範）
 *
 * 持久化：localStorage key = market:symbol:date，切換股票或日期不會互污染。
 * v2 舊 cache 在 mount 時自動清除（一次性遷移）。
 */

import { useEffect, useRef, useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { classifySignal } from '@/lib/rules/signalClassifier';
import type { CandleWithIndicators } from '@/types';
import type {
  DataCategory,
  DataPoint,
  DigestResponse,
  ReasoningItem,
  ReasoningSection,
} from '@/lib/ai/zhuTypes';

const HISTORY_STORAGE_KEY_V2 = 'chart-coach-digest-v2';
const HISTORY_STORAGE_KEY_V3 = 'chart-coach-digest-v3';
const HISTORY_STORAGE_KEY = 'chart-coach-digest-codex-v4';
const HISTORY_MAX_ENTRIES = 40;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface HistoryEntry {
  digest: DigestResponse;
  chat: ChatMessage[];
  savedAt: string;
}

type AnalysisJobState = 'preparing' | 'queued' | 'running' | 'completed' | 'failed';

interface AnalysisJobStatus {
  jobId: string;
  state: AnalysisJobState;
  queuePosition: number | null;
  activeCount: number;
  queuedCount: number;
  maxConcurrent: number;
  elapsedMs: number;
  phaseElapsedMs: number;
  result?: DigestResponse;
  error?: string;
}

type HistoryMap = Record<string, HistoryEntry>;

function storageKey(market: string, symbol: string, date: string): string {
  return `${market}:${symbol}:${date}`;
}

/** narrow v1/v2 舊資料 → 只接 schemaVersion=3 */
function isValidV3(d: unknown): d is DigestResponse {
  if (!d || typeof d !== 'object') return false;
  const v = d as { schemaVersion?: number; reasoning?: unknown; dataPoints?: unknown };
  return v.schemaVersion === 3 && Array.isArray(v.reasoning) && Array.isArray(v.dataPoints);
}

function loadHistory(): HistoryMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed as HistoryMap : {};
  } catch {
    return {};
  }
}

function saveHistoryEntry(key: string, entry: HistoryEntry): void {
  if (typeof window === 'undefined') return;
  try {
    const map = loadHistory();
    map[key] = entry;
    const entries = Object.entries(map);
    if (entries.length > HISTORY_MAX_ENTRIES) {
      entries.sort((a, b) => (b[1].savedAt ?? '').localeCompare(a[1].savedAt ?? ''));
      const kept = Object.fromEntries(entries.slice(0, HISTORY_MAX_ENTRIES));
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(kept));
    } else {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // quota 滿就算了
  }
}

function loadHistoryEntry(key: string): HistoryEntry | null {
  const hit = loadHistory()[key];
  if (!hit || !isValidV3(hit.digest)) return null;
  return hit;
}

function formatSavedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return `今天 ${hh}:${mm}`;
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    return `${MM}/${DD} ${hh}:${mm}`;
  } catch {
    return '';
  }
}

function displaySymbol(s: string): string {
  return s.replace(/\.(TW|TWO|SS|SZ)$/i, '');
}

function isAnalysisJobStatus(value: unknown): value is AnalysisJobStatus {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<AnalysisJobStatus>;
  return typeof job.jobId === 'string'
    && ['preparing', 'queued', 'running', 'completed', 'failed'].includes(job.state ?? '')
    && typeof job.activeCount === 'number'
    && typeof job.maxConcurrent === 'number';
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒` : `${seconds}秒`;
}

/** verdict -> 配色（單行 chip） */
function verdictStyle(v: string): { bg: string; text: string; border: string } {
  const s = v || '觀望';
  if (s.includes('進場') || s.includes('續抱')) {
    return { bg: 'bg-red-900/30', text: 'text-red-200', border: 'border-red-500/50' };
  }
  if (s.includes('出場') || s.includes('減碼')) {
    return { bg: 'bg-green-900/30', text: 'text-green-200', border: 'border-green-500/50' };
  }
  return { bg: 'bg-yellow-900/30', text: 'text-yellow-200', border: 'border-yellow-500/50' };
}

const SECTION_LABELS: Record<ReasoningSection, string> = {
  trend:       '趨勢/位置',
  kbar:        'K 棒型態',
  visual:      '視覺觀察',
  chip:        '籌碼面',
  fundamental: '基本面',
  news:        '新聞/題材',
  macro:       '大盤/總體',
  action:      '操作建議',
};

const SECTION_ORDER: ReasoningSection[] = [
  'trend', 'kbar', 'visual', 'chip', 'fundamental', 'news', 'macro', 'action',
];

/** 預設展開前 3 段（趨勢/K棒/視覺），其餘折疊 */
const DEFAULT_OPEN: ReasoningSection[] = ['trend', 'kbar', 'visual'];

const CATEGORY_LABELS: Record<DataCategory, string> = {
  technical:  '技術',
  chip:       '籌碼',
  fundamental:'基本面',
  news:       '新聞',
  macro:      '大盤',
  valuation:  '估值',
  governance: '治理',
  industry:   '產業',
};

const CATEGORY_ORDER: DataCategory[] = [
  'technical', 'chip', 'fundamental', 'valuation', 'industry', 'news', 'macro', 'governance',
];

function orderedReasoning(items: ReasoningItem[]): ReasoningItem[] {
  const byKey = new Map<ReasoningSection, ReasoningItem>();
  for (const r of items) byKey.set(r.section, r);
  return SECTION_ORDER.map(s => byKey.get(s)).filter((x): x is ReasoningItem => !!x);
}

function groupDataPoints(points: DataPoint[]): Array<{ category: DataCategory; items: DataPoint[] }> {
  const map = new Map<DataCategory, DataPoint[]>();
  for (const p of points) {
    const arr = map.get(p.category) ?? [];
    arr.push(p);
    map.set(p.category, arr);
  }
  return CATEGORY_ORDER
    .map(c => ({ category: c, items: map.get(c) ?? [] }))
    .filter(g => g.items.length > 0);
}

function buildFollowupContext(
  digest: DigestResponse,
  symbol: string,
  name: string,
  date: string,
  candle: CandleWithIndicators,
): string {
  const lines: string[] = [];
  lines.push(`[走圖頁單股分析 · ${displaySymbol(symbol)} ${name} · ${date}]`);
  lines.push('');
  if (digest.overview) lines.push(`總評：${digest.overview}`);
  lines.push(`結論：${digest.verdict} — ${digest.verdictReason}`);
  if (digest.reasoning.length > 0) {
    lines.push('');
    lines.push('## 8 段分析：');
    for (const r of orderedReasoning(digest.reasoning)) {
      lines.push(`【${SECTION_LABELS[r.section]}】${r.text}`);
    }
  }
  if (digest.dataPoints.length > 0) {
    lines.push('');
    lines.push(`## Codex 查到的數值（${digest.dataPoints.length} 筆，列前 10）：`);
    for (const p of digest.dataPoints.slice(0, 10)) {
      const asOf = p.asOf ? ` · ${p.asOf}` : '';
      lines.push(`  · [${CATEGORY_LABELS[p.category]}] ${p.label}: ${p.value} (${p.source}${asOf})`);
    }
  }
  if (digest.caveat) lines.push(`⚠️ ${digest.caveat}`);
  lines.push('');
  lines.push('## 當前 K 棒：');
  lines.push(`O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume}`);
  if (candle.ma5 != null)  lines.push(`MA5=${candle.ma5.toFixed(2)}`);
  if (candle.ma20 != null) lines.push(`MA20=${candle.ma20.toFixed(2)}`);
  return lines.join('\n');
}

interface ChartCoachAdviceProps {
  /** true 時：已有結論的卡片預設摺疊（只顯示題頭 + verdict 一行），點開才出 reasoning + 對話 */
  defaultCollapsed?: boolean;
}

export default function ChartCoachAdvice({ defaultCollapsed = false }: ChartCoachAdviceProps) {
  const {
    currentSignals, allCandles, currentIndex, currentStock,
    trendState, trendPosition, sixConditions, longProhibitions, winnerPatterns,
  } = useReplayStore();
  const { holdings } = usePortfolioStore();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const candle = allCandles[currentIndex];
  const prev   = allCandles[currentIndex - 1];
  const symbol = currentStock?.ticker ?? '';
  const name   = currentStock?.name ?? '';
  const date   = candle?.date ?? '';

  // 判斷市場：.TW/.TWO → TW；.SS/.SZ → CN
  const market: 'TW' | 'CN' = /\.(SS|SZ)$/i.test(symbol) ? 'CN' : 'TW';
  const bareSymbol = displaySymbol(symbol);

  const held = holdings.find(h => displaySymbol(h.symbol) === bareSymbol);
  const hasPosition = !!held;

  const [data, setData] = useState<DigestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [savedAt, setSavedAt] = useState<string | null>(null);
  const aborted = useRef(false);
  const requestVersion = useRef(0);

  const persistKey = (symbol && date) ? storageKey(market, bareSymbol, date) : '';

  // Claude 舊結果不能冒充 Codex 產物；只清除本面板自己的舊 storage key。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(HISTORY_STORAGE_KEY_V2);
      window.localStorage.removeItem(HISTORY_STORAGE_KEY_V3);
    } catch { /* ignore */ }
  }, []);

  // 切股票/切日期：重設 state + 嘗試載入歷史
  useEffect(() => {
    requestVersion.current += 1;
    aborted.current = false;
    setError(null);
    setLoading(false);
    setAnalysisProgress(null);
    setInput('');
    setChatError(null);

    if (!persistKey) {
      setData(null);
      setChat([]);
      setSavedAt(null);
      return;
    }

    const hit = loadHistoryEntry(persistKey);
    if (hit) {
      setData(hit.digest);
      setChat(hit.chat);
      setSavedAt(hit.savedAt);
    } else {
      setData(null);
      setChat([]);
      setSavedAt(null);
    }

    return () => {
      aborted.current = true;
    };
  }, [persistKey]);

  // data/chat 變動 → 持久化
  useEffect(() => {
    if (!data || !persistKey) return;
    const now = new Date().toISOString();
    saveHistoryEntry(persistKey, { digest: data, chat, savedAt: now });
    setSavedAt(now);
  }, [data, chat, persistKey]);

  const ask = async (opts?: { forceRefresh?: boolean }) => {
    if (loading || !candle || !symbol) return;
    const requestId = ++requestVersion.current;
    const isStale = () => aborted.current || requestVersion.current !== requestId;
    setLoading(true);
    setAnalysisProgress(null);
    setError(null);
    try {
      const changePercent = prev ? ((candle.close - prev.close) / prev.close) * 100 : undefined;

      const signals = currentSignals.slice(0, 15).map(s => ({
        label: s.label,
        description: s.description,
        subtype: s.subtype ?? classifySignal(s),
      }));

      // 抓走圖視覺截圖 — Codex 以 image input 直接檢查 K 線型態
      let chartScreenshot: string | null = null;
      try {
        const w = window as unknown as { __rockstockChart?: { takeScreenshot: () => HTMLCanvasElement } };
        const canvas = w.__rockstockChart?.takeScreenshot();
        if (canvas) {
          // image/png base64，扔掉 data URL prefix（"data:image/png;base64,"）只送 raw base64
          const dataUrl = canvas.toDataURL('image/png');
          chartScreenshot = dataUrl.split(',', 2)[1] ?? null;
        }
      } catch (err) {
        console.warn('[ChartCoachAdvice] screenshot failed:', err);
      }

      // 帶 120 天完整歷史 K 線給 Codex（OHLCV + 所有指標）
      // 用來找前波頂底、盤整區間、過往爆量、KD/MACD 背離、均線糾結期等
      const histStart = Math.max(0, currentIndex - 119);
      const recentCandles = allCandles.slice(histStart, currentIndex + 1).map(c => ({
        date: c.date,
        o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
        ma5: c.ma5 ?? null, ma10: c.ma10 ?? null, ma20: c.ma20 ?? null,
        ma60: c.ma60 ?? null, ma240: c.ma240 ?? null,
        avgVol5: c.avgVol5 ?? null,
        kdK: c.kdK ?? null, kdD: c.kdD ?? null,
        macdDIF: c.macdDIF ?? null, macdOSC: c.macdOSC ?? null,
      }));

      const requestBody = JSON.stringify({
        market,
        symbol: bareSymbol,
        name,
        date,
        ohlcv: {
          open: candle.open, high: candle.high, low: candle.low, close: candle.close,
          volume: candle.volume,
          changePercent,
        },
        ma: { ma5: candle.ma5, ma10: candle.ma10, ma20: candle.ma20, ma60: candle.ma60 },
        indicator: {
          kdK: candle.kdK, kdD: candle.kdD,
          macdDIF: candle.macdDIF, macdSignal: candle.macdSignal, macdOSC: candle.macdOSC,
        },
        trend: trendState ?? '',
        trendPosition: trendPosition ?? '',
        sixCond: sixConditions?.totalScore,
        sixCondBreakdown: sixConditions ? {
          trend:     sixConditions.trend.pass,
          position:  sixConditions.position.pass,
          kbar:      sixConditions.kbar.pass,
          ma:        sixConditions.ma.pass,
          volume:    sixConditions.volume.pass,
          indicator: sixConditions.indicator.pass,
        } : undefined,
        signals,
        prohibitions: longProhibitions?.reasons ?? [],
        winnerBullishPatterns: winnerPatterns?.bullishPatterns.map(p => p.name) ?? [],
        winnerBearishPatterns: winnerPatterns?.bearishPatterns.map(p => p.name) ?? [],
        hasPosition,
        positionCost: held?.costPrice ?? null,
        recentCandles,
        chartScreenshot,
        forceRefresh: opts?.forceRefresh ?? false,
        asyncProgress: true,
      });
      const res = await fetch('/api/coach/chart-digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      });
      let body: unknown = await res.json();
      if (isStale()) return;
      if (!res.ok) {
        const errorBody = body as { error?: string };
        throw new Error(errorBody?.error ?? `HTTP ${res.status}`);
      }

      if (res.status === 202) {
        if (!isAnalysisJobStatus(body)) throw new Error('分析工作狀態格式錯誤');
        let job = body;
        for (;;) {
          if (isStale()) return;
          setAnalysisProgress(job);
          if (job.state === 'completed') {
            body = job.result;
            break;
          }
          if (job.state === 'failed') {
            throw new Error(job.error ?? 'Codex 分析失敗');
          }
          if (job.elapsedMs > 60 * 60 * 1000) {
            throw new Error('Codex 排隊或分析超過 60 分鐘，請重新分析');
          }
          await new Promise(resolve => window.setTimeout(resolve, 1000));
          if (isStale()) return;
          const statusRes = await fetch(
            `/api/coach/chart-digest?jobId=${encodeURIComponent(job.jobId)}`,
            { cache: 'no-store' },
          );
          const statusBody: unknown = await statusRes.json();
          if (!statusRes.ok) {
            const errorBody = statusBody as { error?: string };
            throw new Error(errorBody.error ?? `HTTP ${statusRes.status}`);
          }
          if (!isAnalysisJobStatus(statusBody)) throw new Error('分析進度格式錯誤');
          job = statusBody;
        }
      }

      if (isStale()) return;
      if (!isValidV3(body) || body.generatedBy !== 'codex') {
        throw new Error('Codex 回覆格式不完整，請重新分析');
      }
      setData(body);
      setChat([]);
      setChatError(null);
    } catch (err) {
      if (isStale()) return;
      setError(err instanceof Error ? err.message : 'digest failed');
    } finally {
      if (!isStale()) {
        setAnalysisProgress(null);
        setLoading(false);
      }
    }
  };

  const sendFollowup = async (question: string) => {
    const q = question.trim();
    if (!q || chatLoading || !data || !candle) return;
    const nextMessages: ChatMessage[] = [...chat, { role: 'user', content: q }];
    setChat([...nextMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setChatLoading(true);
    setChatError(null);
    try {
      const requestBody = JSON.stringify({
        messages: nextMessages,
        context: buildFollowupContext(data, symbol, name, date, candle),
      });
      const res = await fetch('/api/coach/codex-followup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(errorBody?.error ?? `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('Codex 沒有回傳內容');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (aborted.current) return;
        assistantText += decoder.decode(value, { stream: true });
        setChat(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: assistantText };
          return copy;
        });
      }
    } catch (err) {
      if (aborted.current) return;
      setChatError(err instanceof Error ? err.message : 'chat failed');
      setChat(prev => prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev);
    } finally {
      if (!aborted.current) setChatLoading(false);
    }
  };

  if (!candle || !symbol) return null;

  // 初始：按鈕
  if (!data && !loading && !error) {
    return (
      <button
        onClick={() => ask()}
        className="w-full mb-3 px-3 py-2 rounded-lg border border-purple-500/40 bg-gradient-to-r from-purple-500/15 to-indigo-500/15 hover:from-purple-500/25 hover:to-indigo-500/25 text-[12px] font-semibold text-purple-100 transition-all flex items-center justify-center gap-2"
      >
        <span>💬</span>
        <span>請 Codex 幫我分析 {bareSymbol} {name}</span>
      </button>
    );
  }

  if (loading) {
    const state = analysisProgress?.state ?? 'preparing';
    const phaseIndex = state === 'preparing' ? 0 : state === 'queued' ? 1 : 2;
    const title = state === 'queued'
      ? `💬 排隊中 · 第 ${analysisProgress?.queuePosition ?? '—'} 位`
      : state === 'running'
        ? '💬 Codex 正在進行深度分析'
        : '💬 正在整理走圖、課程與最新資料';
    const detail = state === 'queued'
      ? `目前 ${analysisProgress?.activeCount ?? 0}/${analysisProgress?.maxConcurrent ?? 3} 個分析槽使用中，輪到時會自動開始。`
      : state === 'running'
        ? `目前 ${analysisProgress?.activeCount ?? 1}/${analysisProgress?.maxConcurrent ?? 3} 個分析槽使用中；本階段已執行 ${formatElapsed(analysisProgress?.phaseElapsedMs ?? 0)}。`
        : '完成資料準備後會自動取得分析槽；同一時間最多分析 3 檔股票。';
    return (
      <div className="w-full mb-3 px-3 py-3 rounded-lg border border-purple-500/30 bg-purple-500/5 text-[11px] text-purple-200 space-y-1.5">
        <div className="animate-pulse text-center font-semibold">{title}</div>
        <div className="grid grid-cols-4 gap-1" aria-label="分析階段進度">
          {['準備資料', '排隊', '深度分析', '完成'].map((label, index) => (
            <div
              key={label}
              className={`rounded px-1 py-1 text-center text-[9px] border ${
                index < phaseIndex
                  ? 'border-purple-400/40 bg-purple-500/25 text-purple-100'
                  : index === phaseIndex
                    ? 'border-purple-300/70 bg-purple-500/35 text-white'
                    : 'border-purple-500/15 bg-purple-500/5 text-purple-200/45'
              }`}
            >
              {index < phaseIndex ? '✓ ' : ''}{label}
            </div>
          ))}
        </div>
        <div className="text-purple-200/70 leading-relaxed text-center">
          {detail}
        </div>
        {analysisProgress && (
          <div className="flex items-center justify-center gap-3 text-[10px] text-purple-200/55">
            <span>總經過 {formatElapsed(analysisProgress.elapsedMs)}</span>
            {state === 'queued' && <span>隊列共 {analysisProgress.queuedCount} 筆</span>}
          </div>
        )}
        <div className="text-[9px] text-purple-200/45 text-center">
          顯示真實階段、順位與時間；Codex CLI 不提供可靠百分比。
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full mb-3 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/5 text-[11px] text-red-300 flex items-center justify-between gap-2">
        <span>💬 Codex 分析異常：{error}</span>
        <button
          onClick={() => ask({ forceRefresh: true })}
          className="text-[11px] text-red-200 hover:text-red-100 px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30"
        >重試</button>
      </div>
    );
  }

  if (!data) return null;

  const vs = verdictStyle(data.verdict);
  const reasoning = orderedReasoning(data.reasoning);
  const dpGroups = groupDataPoints(data.dataPoints);

  return (
    <div className="w-full mb-3 rounded-lg border border-purple-500/40 bg-gradient-to-br from-purple-500/10 via-card to-indigo-500/5 p-3 space-y-2 text-[11px]">
      {/* 頂條（無 ABCDE 徽章） */}
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-purple-200 flex items-center gap-1.5 min-w-0 flex-1">
          <span className="shrink-0">💬 Codex · 朱老師體系</span>
          {savedAt && (
            <span className="text-[9px] text-muted-foreground font-normal truncate">
              · {formatSavedAt(savedAt)}
            </span>
          )}
          {data.cached && (
            <span className="text-[9px] text-muted-foreground font-normal shrink-0">（cache）</span>
          )}
        </div>
        <button
          onClick={() => ask({ forceRefresh: true })}
          className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted shrink-0"
          title="重新分析（略過快取，重新請 Codex 查核）"
        >🔄</button>
      </div>

      {/* overview */}
      {data.overview && (
        <div className="text-foreground font-semibold leading-relaxed">{data.overview}</div>
      )}

      {/* verdict 單行 chip */}
      <div className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] ${vs.bg} ${vs.border} ${vs.text}`}>
        <span className="font-semibold">結論：</span>
        <span className="font-bold">{data.verdict}</span>
        {data.verdictReason && <span className="opacity-90">— {data.verdictReason}</span>}
      </div>

      {/* defaultCollapsed=true 時：reasoning + dataPoints + 對話框可摺疊 */}
      {defaultCollapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(v => !v)}
          className="w-full flex items-center justify-between text-[10px] text-muted-foreground hover:text-foreground py-0.5"
        >
          <span>{collapsed ? '展開分析與數值' : '收起分析'}</span>
          <span>{collapsed ? '▼' : '▲'}</span>
        </button>
      )}

      {/* 📊 Codex 查到的數值（折疊面板） */}
      {!collapsed && data.dataPoints.length > 0 && (
        <details className="rounded border border-emerald-500/30 bg-emerald-500/5">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-semibold text-emerald-200 select-none flex items-center justify-between">
            <span>📊 Codex 查到的數值（{data.dataPoints.length} 筆）</span>
            <span className="text-[9px] text-emerald-300/70">點擊展開</span>
          </summary>
          <div className="px-2 pb-2 pt-1 space-y-2">
            {dpGroups.map(g => (
              <div key={g.category} className="space-y-0.5">
                <div className="text-[10px] font-semibold text-emerald-300/90">
                  {CATEGORY_LABELS[g.category]}（{g.items.length}）
                </div>
                {g.items.map((p, i) => (
                  <div key={`${g.category}-${i}`} className="pl-2 leading-snug">
                    <span className="text-foreground">{p.label}：</span>
                    <span className="font-semibold text-foreground/90">{p.value}</span>
                    <span className="text-[9px] text-muted-foreground/70 ml-1">
                      （{p.source}{p.asOf ? ` · ${p.asOf}` : ''}）
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* 8 段 reasoning 折疊區 */}
      {!collapsed && reasoning.length > 0 && (
        <div className="space-y-1">
          {reasoning.map((r) => {
            const open = DEFAULT_OPEN.includes(r.section);
            return (
              <details key={r.section} open={open} className="group rounded border border-border bg-secondary/30">
                <summary className="cursor-pointer px-2 py-1 text-[10px] font-semibold text-foreground select-none">
                  {SECTION_LABELS[r.section]}
                </summary>
                <div className="px-2 pb-1.5 pt-0 text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {r.text}
                </div>
              </details>
            );
          })}
        </div>
      )}

      {!collapsed && data.caveat && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-200">
          ⚠️ {data.caveat}
        </div>
      )}

      {/* 追問區（收起時不顯示）*/}
      {!collapsed && (
      <div className="pt-2 mt-2 border-t border-purple-500/20 space-y-1.5">
        {chat.length > 0 && (
          <div className="space-y-1.5 max-h-[320px] overflow-y-auto pr-1">
            {chat.map((m, i) => (
              <div
                key={i}
                className={`rounded px-2 py-1.5 ${
                  m.role === 'user'
                    ? 'bg-blue-500/20 text-blue-100'
                    : 'bg-secondary/60 text-foreground border border-border'
                }`}
              >
                <div className="text-[9px] text-muted-foreground mb-0.5">
                  {m.role === 'user' ? '你' : 'Codex'}
                </div>
                <div className="text-[11px] leading-relaxed whitespace-pre-wrap">
                  {m.content || (chatLoading && i === chat.length - 1
                    ? <span className="text-muted-foreground animate-pulse">Codex 思考中…</span>
                    : '')}
                </div>
              </div>
            ))}
          </div>
        )}

        {chatError && (
          <div className="text-[10px] text-red-300 border border-red-500/30 rounded px-2 py-1">
            追問失敗：{chatError}
          </div>
        )}

        <div className="flex gap-1.5 items-end">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendFollowup(input);
              }
            }}
            placeholder={chatLoading ? 'Codex 回覆中…' : '想追問 Codex？（Enter 送出，Shift+Enter 換行）'}
            disabled={chatLoading}
            rows={1}
            className="flex-1 min-w-0 px-2 py-1.5 bg-secondary/40 border border-border rounded text-[11px] text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-purple-400 disabled:opacity-50"
          />
          <button
            onClick={() => sendFollowup(input)}
            disabled={!input.trim() || chatLoading}
            className="shrink-0 px-2.5 py-1.5 bg-purple-500/80 hover:bg-purple-500 disabled:opacity-40 text-white rounded text-[11px] font-semibold"
          >送出</button>
        </div>
      </div>
      )}
    </div>
  );
}
