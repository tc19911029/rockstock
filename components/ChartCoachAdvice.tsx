'use client';

/**
 * 走圖頁單支股票朱老師分析 — schemaVersion=2（8 面向 + 5 燈號 + ABCDE 等級）
 *
 * 取 replayStore 當前 K 棒/訊號/趨勢，送 /api/coach/chart-digest 換結構化建議。
 * 回覆格式：grade / gradeReason / lights / reasoning[8] / overview / verdict / verdictReason / caveat
 *
 * 持久化：localStorage key = market:symbol:date，切換股票或日期不會互污染。
 * v1 舊 cache 在 mount 時自動清除（一次性遷移）。
 */

import { useEffect, useRef, useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { classifySignal } from '@/lib/rules/signalClassifier';
import type { CandleWithIndicators } from '@/types';
import type {
  DigestResponse,
  Grade,
  Light,
  ReasoningItem,
  ReasoningSection,
  ZhuLights,
} from '@/lib/ai/zhuTypes';

const HISTORY_STORAGE_KEY_V1 = 'chart-coach-digest-v1';   // 舊版，mount 時清掉
const HISTORY_STORAGE_KEY = 'chart-coach-digest-v2';
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

type HistoryMap = Record<string, HistoryEntry>;

function storageKey(market: string, symbol: string, date: string): string {
  return `${market}:${symbol}:${date}`;
}

/** narrow v1 舊資料 → 只接 schemaVersion=2 */
function isValidV2(d: unknown): d is DigestResponse {
  if (!d || typeof d !== 'object') return false;
  const v = d as { schemaVersion?: number; reasoning?: unknown; lights?: unknown; grade?: unknown };
  return v.schemaVersion === 2 && Array.isArray(v.reasoning) && !!v.lights && !!v.grade;
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
  if (!hit || !isValidV2(hit.digest)) return null;
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

/** ABCDE → 徽章配色（台股紅漲：A 紅、E 灰） */
function gradeStyle(g: Grade): { bg: string; border: string; text: string } {
  switch (g) {
    case 'A': return { bg: 'bg-red-500/80',     border: 'border-red-400',     text: 'text-white' };
    case 'B': return { bg: 'bg-orange-500/70',  border: 'border-orange-400',  text: 'text-white' };
    case 'C': return { bg: 'bg-yellow-500/70',  border: 'border-yellow-400',  text: 'text-yellow-50' };
    case 'D': return { bg: 'bg-zinc-500/70',    border: 'border-zinc-400',    text: 'text-white' };
    case 'E': return { bg: 'bg-zinc-700/80',    border: 'border-zinc-500',    text: 'text-zinc-200' };
  }
}

/** light → emoji + 顏色 class */
function lightDot(l: Light): { emoji: string; cls: string } {
  switch (l) {
    case 'green':  return { emoji: '●', cls: 'text-emerald-400' };
    case 'yellow': return { emoji: '●', cls: 'text-amber-400' };
    case 'red':    return { emoji: '●', cls: 'text-red-400' };
    case 'gray':   return { emoji: '—', cls: 'text-zinc-500' };
  }
}

const LIGHT_LABELS: Array<{ key: keyof ZhuLights; label: string }> = [
  { key: 'technical',   label: '技術' },
  { key: 'chip',        label: '籌碼' },
  { key: 'fundamental', label: '基本面' },
  { key: 'theme',       label: '題材' },
  { key: 'valuation',   label: '估值' },
];

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

function orderedReasoning(items: ReasoningItem[]): ReasoningItem[] {
  // 按固定順序排，朱老師若打亂順序也能 normalize
  const byKey = new Map<ReasoningSection, ReasoningItem>();
  for (const r of items) byKey.set(r.section, r);
  return SECTION_ORDER.map(s => byKey.get(s)).filter((x): x is ReasoningItem => !!x);
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
  lines.push('## 朱老師剛才的評等：');
  lines.push(`等級：${digest.grade}（${digest.gradeReason}）`);
  lines.push(`5 燈號：技術=${digest.lights.technical} 籌碼=${digest.lights.chip} 基本面=${digest.lights.fundamental} 題材=${digest.lights.theme} 估值=${digest.lights.valuation}`);
  if (digest.overview) lines.push(`總評：${digest.overview}`);
  lines.push(`結論：${digest.verdict} — ${digest.verdictReason}`);
  if (digest.reasoning.length > 0) {
    lines.push('');
    lines.push('## 8 段分析：');
    for (const r of orderedReasoning(digest.reasoning)) {
      const tag = r.overridden ? ' [朱老師覆寫]' : '';
      lines.push(`【${SECTION_LABELS[r.section]}】${tag} ${r.text}`);
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
  const [error, setError] = useState<string | null>(null);

  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [savedAt, setSavedAt] = useState<string | null>(null);
  const aborted = useRef(false);

  const persistKey = (symbol && date) ? storageKey(market, bareSymbol, date) : '';

  // v1 → v2 一次性遷移：mount 時清掉舊 key
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.removeItem(HISTORY_STORAGE_KEY_V1); } catch { /* ignore */ }
  }, []);

  // 切股票/切日期：重設 state + 嘗試載入歷史
  useEffect(() => {
    aborted.current = false;
    setError(null);
    setLoading(false);
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
    setLoading(true);
    setError(null);
    try {
      const changePercent = prev ? ((candle.close - prev.close) / prev.close) * 100 : undefined;

      const signals = currentSignals.slice(0, 15).map(s => ({
        label: s.label,
        description: s.description,
        subtype: s.subtype ?? classifySignal(s),
      }));

      // 抓走圖視覺截圖 — 朱老師 session 是多模態 LLM，Read PNG 能直接「看」K 線型態
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

      // 帶 120 天完整歷史 K 線給朱老師（OHLCV + 所有指標）
      // 朱老師能從這找出：前波頂底、盤整區間、過往爆量、KD/MACD 背離、均線糾結期等
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

      const res = await fetch('/api/coach/chart-digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
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
        }),
      });
      const body = await res.json();
      if (aborted.current) return;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (!isValidV2(body)) throw new Error('朱老師回了舊版 schema，請再試一次（自動會強制重打）');
      setData(body);
      setChat([]);
      setChatError(null);
    } catch (err) {
      if (aborted.current) return;
      setError(err instanceof Error ? err.message : 'digest failed');
    } finally {
      if (!aborted.current) setLoading(false);
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
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages,
          context: buildFollowupContext(data, symbol, name, date, candle),
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
        <span>問朱老師怎麼看 {bareSymbol} {name}</span>
      </button>
    );
  }

  if (loading) {
    return (
      <div className="w-full mb-3 px-3 py-3 rounded-lg border border-purple-500/30 bg-purple-500/5 text-[11px] text-purple-200 space-y-1.5">
        <div className="animate-pulse text-center">💬 朱老師正在查資料分析…</div>
        <div className="text-purple-200/70 leading-relaxed text-center">
          已自動切到朱老師 Terminal 觸發分析。若一直沒回應，請確認名為 <code className="px-1 rounded bg-purple-500/20 text-purple-100 font-mono">Zhu</code> 的 Terminal 有開著、且 macOS 已授權自動化。
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full mb-3 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/5 text-[11px] text-red-300 flex items-center justify-between gap-2">
        <span>💬 老師回覆異常：{error}</span>
        <button
          onClick={() => ask({ forceRefresh: true })}
          className="text-[11px] text-red-200 hover:text-red-100 px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30"
        >重試</button>
      </div>
    );
  }

  if (!data) return null;

  const vs = verdictStyle(data.verdict);
  const gs = gradeStyle(data.grade);
  const reasoning = orderedReasoning(data.reasoning);

  return (
    <div className="w-full mb-3 rounded-lg border border-purple-500/40 bg-gradient-to-br from-purple-500/10 via-card to-indigo-500/5 p-3 space-y-2 text-[11px]">
      {/* 頂條 + ABCDE 徽章 */}
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-purple-200 flex items-center gap-1.5 min-w-0 flex-1">
          <span className="shrink-0">💬 朱老師的話</span>
          {savedAt && (
            <span className="text-[9px] text-muted-foreground font-normal truncate">
              · {formatSavedAt(savedAt)}
            </span>
          )}
          {data.cached && (
            <span className="text-[9px] text-muted-foreground font-normal shrink-0">（cache）</span>
          )}
        </div>
        <div className="flex items-start gap-2 shrink-0">
          <div className="flex flex-col items-end gap-0.5">
            <div
              className={`w-14 h-14 rounded-md border-2 flex items-center justify-center text-2xl font-black leading-none ${gs.bg} ${gs.border} ${gs.text}`}
              title={`等級 ${data.grade}：${data.gradeReason}`}
            >
              {data.grade}
            </div>
            <div className="text-[9px] text-muted-foreground max-w-[120px] text-right leading-tight">
              {data.gradeReason}
            </div>
          </div>
          <button
            onClick={() => ask({ forceRefresh: true })}
            className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted shrink-0"
            title="重新分析（略過 server cache，強制重打朱老師）"
          >🔄</button>
        </div>
      </div>

      {/* 5 燈號橫向 chip 列 */}
      <div className="flex flex-wrap gap-1.5">
        {LIGHT_LABELS.map(({ key, label }) => {
          const dot = lightDot(data.lights[key]);
          const matchSection = reasoning.find(r => r.light != null && (
            (key === 'technical' && (r.section === 'trend' || r.section === 'kbar' || r.section === 'visual')) ||
            (key === 'chip' && r.section === 'chip') ||
            (key === 'fundamental' && r.section === 'fundamental') ||
            (key === 'theme' && r.section === 'news') ||
            (key === 'valuation' && r.section === 'fundamental')
          ));
          return (
            <div
              key={key}
              className="px-2 py-0.5 rounded border border-border bg-secondary/40 flex items-center gap-1 text-[10px]"
              title={matchSection ? matchSection.text : label}
            >
              <span className={dot.cls}>{dot.emoji}</span>
              <span className="text-foreground">{label}</span>
            </div>
          );
        })}
      </div>

      {/* overview + verdict 單行 chip */}
      <div className="flex items-start gap-2 flex-wrap">
        {data.overview && (
          <div className="text-foreground font-semibold leading-relaxed flex-1 min-w-0">
            {data.overview}
          </div>
        )}
      </div>
      <div className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] ${vs.bg} ${vs.border} ${vs.text}`}>
        <span className="font-semibold">結論：</span>
        <span className="font-bold">{data.verdict}</span>
        {data.verdictReason && <span className="opacity-90">— {data.verdictReason}</span>}
      </div>

      {/* defaultCollapsed=true 時：reasoning + 對話框可摺疊 */}
      {defaultCollapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(v => !v)}
          className="w-full flex items-center justify-between text-[10px] text-muted-foreground hover:text-foreground py-0.5"
        >
          <span>{collapsed ? '展開 8 段分析與追問' : '收起 8 段分析'}</span>
          <span>{collapsed ? '▼' : '▲'}</span>
        </button>
      )}

      {/* 8 段 reasoning 折疊區 */}
      {!collapsed && reasoning.length > 0 && (
        <div className="space-y-1">
          {reasoning.map((r) => {
            const dot = r.light ? lightDot(r.light) : null;
            const open = DEFAULT_OPEN.includes(r.section);
            return (
              <details key={r.section} open={open} className="group rounded border border-border bg-secondary/30">
                <summary className="cursor-pointer px-2 py-1 text-[10px] flex items-center gap-1.5 select-none">
                  {dot && <span className={`${dot.cls} shrink-0`}>{dot.emoji}</span>}
                  <span className="font-semibold text-foreground">{SECTION_LABELS[r.section]}</span>
                  {r.overridden && (
                    <span className="ml-1 text-[9px] px-1 py-0 rounded bg-purple-500/30 text-purple-100 border border-purple-400/50">
                      朱老師覆寫
                    </span>
                  )}
                </summary>
                <div className="px-2 pb-1.5 pt-0 text-[11px] text-muted-foreground leading-relaxed">
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
                  {m.role === 'user' ? '你' : '朱老師'}
                </div>
                <div className="text-[11px] leading-relaxed whitespace-pre-wrap">
                  {m.content || (chatLoading && i === chat.length - 1
                    ? <span className="text-muted-foreground animate-pulse">老師思考中…</span>
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
            placeholder={chatLoading ? '老師回覆中…' : '想追問？（Enter 送出，Shift+Enter 換行）'}
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
