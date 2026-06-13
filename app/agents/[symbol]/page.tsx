'use client';

/**
 * /agents/[symbol]?date=YYYY-MM-DD
 *
 * 多代理決策 — 單檔詳情頁（深色 cyan 風 + 全中文）
 *
 * 區塊（由上而下）：
 *   - Header：股票名 + symbol + phase
 *   - CandidateSourcesBlock：為何進入候選池
 *   - 四面向 Agent 並列 verdict（§0 隔離）
 *   - FinalDecisionPanel：第四階段決策（若有）
 *   - TechnicalDetail / NewsDetail / ChipDetail / FundamentalDetail
 *   - RiskDetail（若 P4 跑完）
 *   - DebateDetail：Bull vs Bear 並排對照（若 P4 跑完）
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PageShell, PageHeader, BackButton } from '@/components/shared';
import { DatePicker } from '@/components/ui/DatePicker';
import { AgentChartSection } from './_components/AgentChartSection';
import { SellHeavinessReference } from '@/components/shared/SellHeavinessReference';
import { classifyMarket } from '@/lib/market/classify';
import { TrustMomentumPanel } from './_components/TrustMomentumPanel';
import { SqueezeDetail } from './_components/SqueezeDetail';
import { CostBasisPanel } from './_components/CostBasisPanel';
import { ValuationDetail } from './_components/ValuationDetail';
import { StockGradeSummary } from '@/components/agents/StockGradeSummary';
import { AgentScorePanel } from '@/components/agents/AgentScorePanel';
import { NeedsRescoreBanner } from '@/components/agents/NeedsRescoreBanner';
import { StockMentionTimeline } from '@/components/youtube/StockMentionTimeline';
import type {
  AgentRunMeta,
  AgentPhaseState,
  BearThesis,
  BookCitation,
  BullThesis,
  ChipAnswer,
  ChipSection,
  DataPoint,
  FinalDecision,
  FundamentalAnswer,
  FundamentalQuestion,
  FundamentalSection,
  NewsAnswer,
  NewsSection,
  RiskAnswer,
  TechnicalAnswer,
  TechnicalSection,
} from '@/lib/agents/types';
import type { Candidate, SourceName } from '@/lib/agents/candidates/types';
import { useTotalCapital, formatNT } from '@/lib/portfolio/useTotalCapital';

type Verdict = 'pass' | 'watch' | 'fail';

interface DecisionPayload {
  ok: boolean;
  date: string;
  symbol: string;
  meta: AgentRunMeta | null;
  phase: AgentPhaseState | null;
  candidate: Candidate | null;
  technical: TechnicalAnswer | null;
  news: NewsAnswer | null;
  chip: ChipAnswer | null;
  fundamental: FundamentalAnswer | null;
  fundamentalQuestion: FundamentalQuestion | null;
  risk: RiskAnswer | null;
  bull: BullThesis | null;
  bear: BearThesis | null;
  decision: FinalDecision | null;
  error?: string;
}

const SOURCE_LABEL: Record<SourceName, string> = {
  technical: '技術',
  youtube: '消息',
  chip: '籌碼',
  fundamental: '基本',
};

const SOURCE_COLOR: Record<SourceName, string> = {
  technical:   'bg-cyan-900/40 text-cyan-300 border-cyan-700/50',
  youtube:     'bg-fuchsia-900/40 text-fuchsia-300 border-fuchsia-700/50',
  chip:        'bg-orange-900/40 text-orange-300 border-orange-700/50',
  fundamental: 'bg-teal-900/40 text-teal-300 border-teal-700/50',
};

const TECH_SECTION_LABELS: Record<TechnicalSection, string> = {
  trend:  '① 趨勢',
  kbar:   '② K 線',
  ma:     '③ 均線',
  volume: '④ 量能',
  kd:     '⑤ KD / MACD',
  mtf:    '⑥ 長線保護短線',
};

const NEWS_SECTION_LABELS: Record<NewsSection, string> = {
  youtube_consensus: 'YouTube 跨節目共識',
  rss_news:          'RSS 新聞情緒',
  event_risk:        '事件風險',
};

const CHIP_SECTION_LABELS: Record<ChipSection, string> = {
  institutional: '三大法人',
  margin:        '融資融券',
  lending:       '借券',
  large_holders: '大戶持股',
};

const FUNDAMENTAL_SECTION_LABELS: Record<FundamentalSection, string> = {
  revenue:   '月營收 / YoY',
  profit:    '獲利能力',
  valuation: '估值',
  industry:  '產業',
};

/**
 * 英文 schema 欄位 → 中文顯示名稱
 *
 * 給 DataPointTable 的 label 欄、entryContext 內訊號代碼用。
 * 找不到就回原字串（保險）。
 */
const FIELD_LABEL_ZH: Record<string, string> = {
  // — Technical —
  price: '收盤價',
  changePercent: '漲跌幅',
  volume: '成交量',
  sixConditionsScore: '六條件分數',
  trendState: '趨勢狀態',
  trendPosition: '位置',
  matchedMethods: '命中買法',
  mtfWeeklyPass: 'MTF 週線通過',
  mtfMonthlyPass: 'MTF 月線通過',
  ma20Slope: 'MA20 斜率',
  highWinRateScore: '高勝率分數',
  winnerBullishPatterns: '飆股多頭型態',
  winnerBearishPatterns: '飆股空頭型態',

  // — Chip —
  chipScore: '籌碼分數',
  chipSignal: '籌碼訊號',
  chipDetail: '籌碼註記',
  foreignBuy: '外資買賣超',
  trustBuy: '投信買賣超',
  dealerBuy: '自營商買賣超',
  totalInstitutional: '三大法人合計',
  marginBalance: '融資餘額',
  marginNet: '融資增減',
  marginUtilRate: '融資使用率',
  shortBalance: '融券餘額',
  shortNet: '融券增減',
  dayTradeVolume: '當沖量',
  dayTradeRatio: '當沖比',
  largeHolderPct: '大戶持股 %',
  largeHolderChange: '大戶持股變化',
  lendingBalance: '借券餘額',
  lendingNet: '借券增減',
  largeTraderBuy: '大戶買',
  largeTraderSell: '大戶賣',
  largeTraderNet: '大戶買賣超',

  // — Fundamental —
  EPS: 'EPS（每股盈餘）',
  'EPS YoY': 'EPS 年增率',
  毛利率: '毛利率',
  淨利率: '淨利率',
  月營收: '月營收',
  '月營收 YoY': '月營收年增率',
  '月營收 MoM': '月營收月增率',
  PER: 'PER（本益比）',
  PBR: 'PBR（股價淨值比）',
  現金殖利率: '現金殖利率',
  產業: '產業',
  eps: 'EPS',
  epsYoY: 'EPS 年增率',
  grossMargin: '毛利率',
  netMargin: '淨利率',
  per: 'PER',
  pbr: 'PBR',
  dividendYield: '現金殖利率',
  revenueLatest: '最新月營收',
  revenueMoM: '月營收 MoM',
  revenueYoY: '月營收 YoY',

  // — News —
  youtube_mention_count: 'YouTube 提及次數',
  youtube_in_high_consensus: 'YouTube 高共識',
  youtube_confidence: 'YouTube 信心分數',
  rss_has_news: 'RSS 有新聞',
  rss_aggregate_sentiment: 'RSS 平均情緒',
  rss_recent_count: 'RSS 近期文章數',
  mentionCount: '提及次數',
  inHighConsensus: '高共識',
  combinedConfidence: '綜合信心',
  hasNews: '有新聞',
  aggregateSentiment: '平均情緒',
  recentCount: '近期文章數',
  sentiment: '情緒',
};

/** 訊號代碼 → 中文 */
const SIGNAL_ZH: Record<string, string> = {
  chip_score_high: '籌碼分數高',
  chip_score_mid: '籌碼分數中',
  chip_score_low: '籌碼分數低',
  foreign_buying: '外資買超',
  trust_buying: '投信買超',
  margin_overheated: '融資過熱',
  large_holder_increasing: '大戶加碼',
  large_holder_decreasing: '大戶減碼',
  has_fundamental_data: '有基本面資料',
  has_news_data: '有新聞資料',
  revenue_growth: '營收成長',
  eps_growth: 'EPS 成長',
  bullish: '看多',
  bearish: '看空',
  mixed: '多空混雜',
  mentioned_only: '僅提及',
  positive: '正向',
  negative: '負向',
  neutral: '中立',
};

/** 取中文欄位名（找不到就回原字串）*/
function zhLabel(en: string): string {
  return FIELD_LABEL_ZH[en] ?? en;
}

/** market code → 中文（TW → 台股、CN → 陸股，其餘原樣）*/
function marketLabel(m: string): string {
  const M = m.toUpperCase();
  if (M === 'TW') return '台股';
  if (M === 'CN') return '陸股';
  if (M === 'TWO') return '台股櫃';
  return m;
}

/** 翻譯訊號代碼陣列（找不到的回原字串）*/
function zhSignals(signals: string[]): string {
  return signals.map((s) => SIGNAL_ZH[s] ?? s).join('、');
}

/** BookCitation 的 value 轉中文 */
function zhCitationValue(v: string): string {
  return v
    .replace(/^not_triggered/i, '未觸發')
    .replace(/^triggered/i, '已觸發')
    .replace(/^true\b/, '成立')
    .replace(/^false\b/, '不成立');
}

/**
 * reasoning 內文中文化 — 把 LLM 嵌入的英文 schema 引用翻成中文
 *
 * 處理：
 *   - `prefetch.chip.foreignBuy` → 「預抓.籌碼.外資買賣超」
 *   - `candidateRow.trendState='多頭'` → 「候選池.趨勢狀態='多頭'」
 *   - `mtfMonthlyPass=true` → 「MTF 月線通過=成立」
 *   - `chipScore=54` → 「籌碼分數=54」
 *   - 獨立 `=true` / `=false` / `not_triggered` 也轉
 *
 * 書本 ruleId（zhu-xxx / sop-xxx / kline-xxx）保留 — 那是書本引用
 */
function zhText(text: string): string {
  let t = text;

  // (1) path 引用：prefetch.chip.fieldName → 預抓.籌碼.中文
  t = t
    .replace(/prefetch\.chip\.(\w+)/g, (_m, f) => `預抓.籌碼.${zhLabel(f)}`)
    .replace(/prefetch\.fundamentals\.(\w+)/g, (_m, f) => `預抓.基本面.${zhLabel(f)}`)
    .replace(/prefetch\.youtube\.(\w+)/g, (_m, f) => `預抓.YouTube.${zhLabel(f)}`)
    .replace(/prefetch\.rss\.(\w+)/g, (_m, f) => `預抓.RSS.${zhLabel(f)}`)
    .replace(/candidateRow\.(\w+)/g, (_m, f) => `候選池.${zhLabel(f)}`)
    .replace(/groundTruth\.industry/g, '候選池.產業');

  // (2) 書本 ruleId（c-/p-/e-/m- 前綴）— 不要翻 suffix，但 =true/false 轉成立/不成立
  //     注意：這要在 (3) 通用 = 處理之前做，否則 c-volume=true 會被翻成 c-成交量=成立
  t = t.replace(/\b((?:c|p|e|m)-[a-zA-Z][\w-]*)=true\b/g, '$1=成立')
       .replace(/\b((?:c|p|e|m)-[a-zA-Z][\w-]*)=false\b/g, '$1=不成立');

  // (3) 一般 schema 欄位 = bool/數值/字串
  t = t
    .replace(/\b([a-zA-Z][\w]+)=true\b/g, (_m, k) => `${zhLabel(k)}=成立`)
    .replace(/\b([a-zA-Z][\w]+)=false\b/g, (_m, k) => `${zhLabel(k)}=不成立`)
    .replace(/\b([a-zA-Z][\w]+)=null\b/g, (_m, k) => `${zhLabel(k)}=無`)
    .replace(/\b([a-zA-Z][\w]+)=\[\]/g, (_m, k) => `${zhLabel(k)}=空`)
    .replace(/\b([a-zA-Z][\w]+)=([\d.]+(?:[%xX])?)\b/g, (_m, k, v) => `${zhLabel(k)}=${v}`)
    .replace(/\b([a-zA-Z][\w]+)='([^']+)'/g, (_m, k, v) => `${zhLabel(k)}='${v}'`);

  // (4) 獨立 not_triggered / triggered
  t = t.replace(/\bnot_triggered\b/g, '未觸發').replace(/\btriggered\b/g, '已觸發');

  // (5) 剝掉 ruleId 行內引用 ── 兩種型態：
  //     A) ()包起來：(kline-trading-bull-entry BUY) 或 (zhu-xxx BUY，停損 54.40)
  //     B) 沒包：zhu-surge-volume-5types 攻擊量... ← 整段刪到下個空白
  const RULE_PREFIX = '(?:zhu|sop|kline|granville|smart|triple|surge|gap|long-term)';
  // A) 加上「BUY 後可跟逗號 + 任意字直到 )」的容忍
  t = t.replace(
    new RegExp(`\\s*\\(${RULE_PREFIX}-[\\w-]+(?:\\s+(?:BUY|WATCH|SELL|ADD)(?:[^)]*)?)?\\)`, 'g'),
    '',
  );
  // B) bare ruleId — 去掉整個 token（保留前後空白以便讀）
  t = t.replace(new RegExp(`\\s*\\b${RULE_PREFIX}-[a-zA-Z][\\w-]+\\b`, 'g'), '');

  // (6) bare schema 欄位名（camelCase 且在 FIELD_LABEL_ZH 命中）→ 中文
  //     用 lookbehind 避免吃到 ruleId 內字（如 c-volume 的 volume）
  t = t.replace(/(?<![\w-])([a-z][a-zA-Z]+[A-Z][a-zA-Z]+)(?![\w-])/g, (m, w) => FIELD_LABEL_ZH[w] ?? m);

  // (7) bare 一字 schema 詞彙（在 overview 文本中常見）
  const BARE_WORDS: Record<string, string> = {
    fundamentals: '基本面欄位',
    prefetch: '預抓資料',
    contexts: '節錄段落',
    videoIds: '影片 ID',
    articles: '文章',
    article: '文章',
    summary: '摘要',
    industry: '產業',
    sentiment: '情緒',
    verdict: '判定',
    matched: '配對',
    data: '資料',
    null: '無資料',
    signals: '訊號',
    chipscore: '籌碼分數',
    chipsignal: '籌碼訊號',
    chipdetail: '籌碼註記',
  };
  t = t.replace(/(?<![\w-])([a-zA-Z]+)(?![\w-])/g, (m, w) => {
    const lw = w.toLowerCase();
    return BARE_WORDS[lw] ?? m;
  });

  return t;
}

/** DataPointTable source 欄翻成中文 */
function zhSource(source: string): string {
  if (source.startsWith('L4.candidateRow.')) {
    const field = source.replace('L4.candidateRow.', '');
    return `候選池.${zhLabel(field)}`;
  }
  if (source.startsWith('prefetch.chip.')) return `預抓.籌碼.${zhLabel(source.replace('prefetch.chip.', ''))}`;
  if (source.startsWith('prefetch.fundamentals')) return `預抓.基本面.${zhLabel(source.replace('prefetch.fundamentals.', ''))}`;
  if (source.startsWith('prefetch.youtube.')) return `預抓.YouTube.${zhLabel(source.replace('prefetch.youtube.', ''))}`;
  if (source.startsWith('prefetch.rss.')) return `預抓.RSS.${zhLabel(source.replace('prefetch.rss.', ''))}`;
  if (source.startsWith('groundTruth.industry')) return '候選池.產業';
  return source;  // 未知前綴保留原文
}

function VerdictBadge({ verdict, size = 'md' }: { verdict: Verdict; size?: 'sm' | 'md' }) {
  const cfg: Record<Verdict, { label: string; cls: string }> = {
    pass:  { label: '✅ 通過',   cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50' },
    watch: { label: '👀 觀察',   cls: 'bg-amber-900/50 text-amber-300 border-amber-700/50' },
    fail:  { label: '⛔ 不通過', cls: 'bg-rose-900/50 text-rose-300 border-rose-700/50' },
  };
  const c = cfg[verdict];
  const sizing = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={`inline-flex items-center rounded-md border font-semibold ${sizing} ${c.cls}`}>
      {c.label}
    </span>
  );
}

function todayYmd(): string {
  const tpe = new Date(Date.now() + 8 * 3600_000);
  return tpe.toISOString().slice(0, 10);
}

/** 最近一個工作日（不含今天）— 週末/週一早上打開時，今天通常還沒有資料 */
function lastBusinessDay(): string {
  const tpe = new Date(Date.now() + 8 * 3600_000);
  tpe.setUTCDate(tpe.getUTCDate() - 1);
  while (tpe.getUTCDay() === 0 || tpe.getUTCDay() === 6) {
    tpe.setUTCDate(tpe.getUTCDate() - 1);
  }
  return tpe.toISOString().slice(0, 10);
}

export default function AgentDetailPageWrapper() {
  return <Suspense fallback={<div className="p-6 text-muted-foreground">載入中…</div>}><AgentDetailPage /></Suspense>;
}

function AgentDetailPage() {
  const { symbol } = useParams<{ symbol: string }>();
  const searchParams = useSearchParams();
  // 預設用「最近工作日」而非今天 — 週末/早上打開時，今天通常沒有 scan 資料
  // URL ?date= 仍可 override
  const initialDate = searchParams.get('date') ?? lastBusinessDay();

  const [date, setDate] = useState(initialDate);
  const [data, setData] = useState<DecisionPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Fallback name 來源 — 當 decisions API 沒有 candidate.name 時，用 /api/stock 拿真實名稱
  // 防止 header 顯示「（未知名稱）」這種讓 user 困惑的字
  const [fallbackName, setFallbackName] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/decisions/${encodeURIComponent(symbol)}?date=${date}`);
      const json = (await res.json()) as DecisionPayload;
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setData(null);
      } else {
        setData(json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [symbol, date]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // 如果 decisions API 沒回 candidate.name，直接從 /api/stock 拿真實名稱
  useEffect(() => {
    if (data?.candidate?.name) return;  // 已有名稱
    if (fallbackName) return;            // 已抓過
    let cancelled = false;
    fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&interval=1d&period=1mo`)
      .then(r => r.json())
      .then(j => { if (!cancelled && j?.name) setFallbackName(j.name); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [symbol, data?.candidate?.name, fallbackName]);

  const prepareAgent = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/agents/prepare?date=${date}&symbol=${encodeURIComponent(symbol)}`,
        { method: 'POST' },
      );
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) setError(json.error ?? `HTTP ${res.status}`);
      else { setError(null); await fetchData(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'prepare failed');
    } finally {
      setLoading(false);
    }
  }, [symbol, date, fetchData]);

  const phaseLabel = useMemo(() => {
    const p = data?.phase;
    if (!p) return '未開始';
    if (p.currentPhase === 'completed') return '✅ 全部階段完成';
    return `第 ${p.currentPhase} 階段進行中`;
  }, [data]);

  const completedCount = useMemo(() => {
    if (!data) return 0;
    return [data.technical, data.news, data.chip, data.fundamental].filter(Boolean).length;
  }, [data]);

  const symbolPageHeader = (
    <PageHeader
      title={data?.candidate?.name ?? fallbackName ?? symbol}
      backButton={`/agents?date=${date}`}
      subtitle={
        <span className="font-mono">
          {symbol}{data?.meta?.market && !symbol.toUpperCase().endsWith(`.${data.meta.market}`) ? ` · ${marketLabel(data.meta.market)}` : ''} · {phaseLabel} · {completedCount}/4
        </span>
      }
    />
  );

  return (
    <PageShell headerSlot={symbolPageHeader}>
      <div className="min-h-full">
        {/* ───────── CONTROL BAR ───────── */}
        <header className="border-b border-border bg-card sticky top-12 z-10">
          <div className="max-w-[1200px] mx-auto px-6 py-3 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-baseline gap-2 flex-wrap">
                <span className="text-sky-500">
                  {data?.candidate?.name ?? fallbackName ?? <span className="text-muted-foreground">…</span>}
                </span>
                <span className="text-base font-mono font-normal text-muted-foreground">{symbol}</span>
                {data?.meta?.market && !symbol.toUpperCase().endsWith(`.${data.meta.market}`) && (
                  <span className="text-xs font-normal text-muted-foreground">{marketLabel(data.meta.market)}</span>
                )}
              </h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                多代理分析 · {phaseLabel} · {completedCount}/4 個分析師完成
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <BackButton href={`/agents?date=${date}`} label="回列表" variant="with-label" />
              <DatePicker value={date} onChange={setDate} size="md" />
              <button
                onClick={prepareAgent}
                disabled={loading || (!data?.candidate && completedCount === 0)}
                title={!data?.candidate && completedCount === 0 ? '此股票不在當日掃描候選池，無法跑多代理分析' : undefined}
                className="bg-sky-500 hover:bg-sky-400 text-white px-3 py-1 rounded text-xs font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {completedCount > 0 ? '⚡ 重新準備' : '⚡ 開始準備'}
              </button>
              <button
                onClick={fetchData} disabled={loading}
                className="border border-border hover:bg-secondary px-3 py-1 rounded text-xs transition disabled:opacity-50"
              >
                ⟲ 重整
              </button>
            </div>
          </div>
        </header>

        {/* ───────── BODY ───────── */}
        <div className="max-w-[1200px] mx-auto px-6 py-4 space-y-4">
          {error && (
            <div className="border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300 rounded p-3 text-sm whitespace-pre-wrap">
              {error}
            </div>
          )}

          {loading && !data && <p className="text-muted-foreground">載入中…</p>}

          {data && completedCount === 0 && !error && data.candidate && (
            <div className="border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-200 rounded-lg p-4 text-sm space-y-2">
              <p className="font-medium">這檔股票還沒跑過分析。</p>
              <ol className="list-decimal ml-5 space-y-1">
                <li>點上方「開始準備」會幫這檔股票準備 4 個分析提示（技術／消息／籌碼／基本面各一）</li>
                <li>在 Claude Code 對話中輸入 <code className="bg-amber-500/20 text-amber-700 dark:text-amber-200 px-1.5 py-0.5 rounded font-mono text-xs">/multi-agent-decide</code> 才會實際跑分析</li>
                <li>對話跑完 4 個面向後回此頁按「⟲ 重整」即可看到結果</li>
              </ol>
            </div>
          )}

          {/* DU3 完整 gate：非候選股 — 無法跑多代理，用明確說明取代邀請式教學 */}
          {data && completedCount === 0 && !error && !data.candidate && (
            <div className="border border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300 rounded-lg p-4 text-sm space-y-1">
              <p className="font-medium">此股票不在「當日掃描候選池」，無法跑多代理分析。</p>
              <p className="text-xs text-muted-foreground">
                多代理只評估掃描器當日選出的候選股。此頁仍可看走圖 + 4 面向資料；要分析請從 <Link href="/agents/pool" className="text-sky-400 underline">候選池</Link> 進入候選股，或先在 <Link href="/" className="text-sky-400 underline">首頁</Link> 掃描挑出候選。
              </p>
            </div>
          )}

          {/* Stage 5：內嵌走圖（與首頁、/youtube/replay 同一套 StockChartView） */}
          <AgentChartSection symbol={symbol} scanDate={date} />

          {/* 為何進入候選池 */}
          {data?.candidate && <CandidateSourcesBlock candidate={data.candidate} />}

          {/* v1 評分系統:有 gradeBlock → Summary;沒有 → NeedsRescoreBanner + 既有 verdict 並列 fallback */}
          {data?.decision?.gradeBlock ? (
            <StockGradeSummary
              decision={data.decision}
              symbol={symbol}
              name={data.candidate?.name}
              date={date}
            />
          ) : data && completedCount > 0 ? (
            <>
              <NeedsRescoreBanner date={date} symbol={symbol} />
              <Panel title="四面向並列觀點" subtitle="§0 隔離原則:各代理獨立 verdict、不混合加權">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
                  <VerdictCard title="技術面" answer={data.technical} />
                  <VerdictCard title="消息面" answer={data.news} />
                  <VerdictCard title="籌碼面" answer={data.chip} />
                  <VerdictCard title="基本面" answer={data.fundamental} />
                </div>
              </Panel>
            </>
          ) : null}

          {/* 最終決策(操作參數:action / 進場 / 停損 / 目標)*/}
          {data?.decision && <FinalDecisionPanel decision={data.decision} />}

          {/* 4 大面評分卡(分數導向)— Chip 內嵌投信動向 sub-section */}
          {data?.technical && (
            <AgentScorePanel
              agentId="technical"
              title="技術面 Agent"
              subtitle="朱家泓六條件 + 戒律 + 淘汰法 + 林穎 MTF"
              answer={data.technical}
            />
          )}
          {data?.news && (
            <AgentScorePanel
              agentId="news"
              title="消息題材面 Agent"
              subtitle="YouTube 跨節目共識 + 新聞情緒 + 產業題材"
              answer={data.news}
            />
          )}
          {data?.chip && (
            <AgentScorePanel
              agentId="chip"
              title="籌碼資金面 Agent"
              subtitle="三大法人 + 投信 3比8 + ETF 共識 + 大戶分層 + 融資借券"
              answer={data.chip}
              extraSlot={<TrustMomentumPanel symbol={symbol} date={date} />}
            />
          )}
          {data?.fundamental && (
            <AgentScorePanel
              agentId="fundamental"
              title="基本估值面 Agent"
              subtitle="月營收 / EPS / 毛利率 / ROE / PER 歷史比較"
              answer={data.fundamental}
            />
          )}

          {/* 各代理詳細推理(reasoning + dataPoints + bookCitations,展開深度視角)*/}
          {data?.technical && <TechnicalDetail answer={data.technical} />}
          {data?.news && <NewsDetail answer={data.news} />}
          {/* YouTube 逐筆提及時間軸（重用 history API + 共用 timeline 元件，§0：純消息面視角）*/}
          <div className="border border-slate-700 rounded p-3 bg-slate-800/30 space-y-2">
            <h3 className="text-sm font-semibold text-cyan-300">YouTube 提及紀錄（近 30 天）</h3>
            <StockMentionTimeline code={symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')} range="30d" />
          </div>
          {data?.chip && <ChipDetail answer={data.chip} market={classifyMarket(symbol)} />}
          {data?.fundamental && <FundamentalDetail answer={data.fundamental} />}
          {(data?.fundamental || data?.fundamentalQuestion?.groundTruth.valuationInputs) && (
            <ValuationDetail answer={data?.fundamental ?? null} question={data?.fundamentalQuestion ?? null} />
          )}
          <SqueezeDetail symbol={symbol} date={date} />
          <CostBasisPanel symbol={symbol} date={date} />
          {data?.risk && <RiskDetail answer={data.risk} />}
          {data?.bull && data?.bear && <DebateDetail bull={data.bull} bear={data.bear} />}
        </div>
      </div>
    </PageShell>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 通用 Panel
// ────────────────────────────────────────────────────────────────────────────

function Panel({
  title, subtitle, children, accent = 'cyan',
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  accent?: 'cyan' | 'emerald' | 'rose' | 'amber';
}) {
  const accentCls: Record<string, string> = {
    cyan:    'border-cyan-700/40',
    emerald: 'border-emerald-700/40',
    rose:    'border-rose-700/40',
    amber:   'border-amber-700/40',
  };
  const titleCls: Record<string, string> = {
    cyan: 'text-cyan-400', emerald: 'text-emerald-400', rose: 'text-rose-400', amber: 'text-amber-400',
  };
  return (
    <section className={`border bg-slate-900 rounded-lg p-4 space-y-3 ${accentCls[accent]}`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className={`text-xs font-semibold tracking-wider ${titleCls[accent]}`}>▸ {title}</h2>
        {subtitle && <span className="text-[10px] text-slate-500 italic">{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// CandidateSources（為何進入候選池）
// ────────────────────────────────────────────────────────────────────────────

function CandidateSourcesBlock({ candidate }: { candidate: Candidate }) {
  const sourceKeys = Object.keys(candidate.sources) as SourceName[];
  return (
    <Panel
      title="為何進入候選池"
      subtitle={`多源命中：${candidate.sourceCount} / 4`}
    >
      <div className="flex gap-1 flex-wrap">
        {sourceKeys.map((s) => (
          <span key={s} className={`inline-flex px-2 py-0.5 rounded border text-xs font-medium ${SOURCE_COLOR[s]}`}>
            {SOURCE_LABEL[s]}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
        {candidate.sources.technical && (
          <SourceCard tone="cyan" title="技術面進入理由">
            <p>命中 <span className="font-mono">{candidate.sources.technical.tracks.length}</span> 條軌：<span className="font-mono">{candidate.sources.technical.tracks.join(' / ')}</span></p>
            <p>命中買法：<span className="font-mono">{candidate.sources.technical.matchedMethods.join(' / ')}</span></p>
            <p>六條件分數：<span className="font-mono">{candidate.sources.technical.sixConditionsScore} / 6</span></p>
            {candidate.sources.technical.reasons.map((r, i) => <p key={i} className="text-slate-400">· {zhText(r)}</p>)}
          </SourceCard>
        )}
        {candidate.sources.youtube && (
          <SourceCard tone="fuchsia" title="消息面進入理由">
            <p>節目提到：<span className="font-mono">{candidate.sources.youtube.mentionCount}</span> 次</p>
            <p>節目：{candidate.sources.youtube.shows.join('、') || '—'}</p>
            <p>情緒：{zhSignals([candidate.sources.youtube.sentiment])} {candidate.sources.youtube.inHighConsensus && '🔥 高共識'}</p>
            <p>綜合信心：<span className="font-mono">{candidate.sources.youtube.combinedConfidence.toFixed(2)}</span></p>
          </SourceCard>
        )}
        {candidate.sources.chip && (
          <SourceCard tone="orange" title="籌碼面進入理由">
            <p>籌碼分數：<span className="font-mono">{candidate.sources.chip.chipScore ?? '—'}</span></p>
            <p>命中訊號：{zhSignals(candidate.sources.chip.signals)}</p>
            {candidate.sources.chip.reasons.map((r, i) => <p key={i} className="text-slate-400">· {zhText(r)}</p>)}
          </SourceCard>
        )}
        {candidate.sources.fundamental && (
          <SourceCard tone="teal" title="基本面進入理由">
            {candidate.sources.fundamental.revenueYoY != null
              ? <p>月營收年增率：<span className="font-mono">{candidate.sources.fundamental.revenueYoY.toFixed(1)}%</span></p>
              : null}
            {candidate.sources.fundamental.epsYoY != null
              ? <p>EPS 年增率：<span className="font-mono">{candidate.sources.fundamental.epsYoY.toFixed(1)}%</span></p>
              : null}
            {candidate.sources.fundamental.grossMargin != null
              ? <p>毛利率：<span className="font-mono">{candidate.sources.fundamental.grossMargin.toFixed(1)}%</span></p>
              : null}
            {candidate.sources.fundamental.revenueYoY == null &&
             candidate.sources.fundamental.epsYoY == null &&
             candidate.sources.fundamental.grossMargin == null &&
             candidate.sources.fundamental.reasons.length > 0
              ? candidate.sources.fundamental.reasons.map((r, i) => <p key={i} className="text-slate-300">· {r}</p>)
              : null}
            <p>命中訊號：{zhSignals(candidate.sources.fundamental.signals)}</p>
          </SourceCard>
        )}
      </div>
    </Panel>
  );
}

function SourceCard({
  tone, title, children,
}: { tone: 'cyan' | 'fuchsia' | 'orange' | 'teal'; title: string; children: React.ReactNode }) {
  const cls: Record<string, string> = {
    cyan:    'border-cyan-700/50 bg-cyan-950/40',
    fuchsia: 'border-fuchsia-700/50 bg-fuchsia-950/40',
    orange:  'border-orange-700/50 bg-orange-950/40',
    teal:    'border-teal-700/50 bg-teal-950/40',
  };
  const titleCls: Record<string, string> = {
    cyan: 'text-cyan-300', fuchsia: 'text-fuchsia-300', orange: 'text-orange-300', teal: 'text-teal-300',
  };
  return (
    <div className={`border rounded p-2.5 space-y-0.5 ${cls[tone]}`}>
      <div className={`font-medium text-sm ${titleCls[tone]}`}>{title}</div>
      <div className="text-slate-300 space-y-0.5">{children}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 四面向並列 VerdictCard
// ────────────────────────────────────────────────────────────────────────────

function VerdictCard({
  title, answer,
}: {
  title: string;
  answer: { verdict: Verdict; overview: string; verdictReason: string } | null;
}) {
  if (!answer) {
    return (
      <div className="border border-slate-700 rounded p-3 bg-slate-800/40">
        <div className="text-xs text-slate-400 mb-1">{title}</div>
        <div className="text-xs text-slate-500">⏳ 等待執行 /multi-agent-decide</div>
      </div>
    );
  }
  return (
    <div className="border border-cyan-700/40 rounded p-3 bg-slate-900 space-y-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs text-slate-400">{title}</span>
        <VerdictBadge verdict={answer.verdict} size="sm" />
      </div>
      <div className="text-sm text-slate-200">{zhText(answer.overview)}</div>
      <div className="text-xs text-slate-400">{zhText(answer.verdictReason)}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Final Decision Panel
// ────────────────────────────────────────────────────────────────────────────

const ACTION_CFG: Record<FinalDecision['action'], { label: string; cls: string; emoji: string }> = {
  buy:   { label: '進場',  cls: 'border-emerald-500/60 bg-emerald-900/30', emoji: '✅' },
  watch: { label: '觀望',  cls: 'border-amber-500/60 bg-amber-900/30',     emoji: '👀' },
  skip:  { label: '不進場', cls: 'border-rose-500/60 bg-rose-900/30',       emoji: '⛔' },
};

function FinalDecisionPanel({ decision }: { decision: FinalDecision }) {
  const cfg = ACTION_CFG[decision.action];
  const v = decision.verdictsByAgent;
  const totalCapital = useTotalCapital();
  // 註：decision.sizeHint 跨資料源已標準化為「百分比值」（如 0.5 = 0.5%），不是 0-1 decimal
  const sizePct = decision.sizeHint;
  const sizeAmount = totalCapital && sizePct > 0 ? formatNT(totalCapital * (sizePct / 100)) : null;
  return (
    <section className={`border-2 rounded-lg p-4 space-y-3 ${cfg.cls}`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{cfg.emoji}</span>
          <div>
            <h2 className="text-xl font-bold text-slate-100">最終決策：{cfg.label}</h2>
            <p className="text-sm text-slate-300">{decision.overview}</p>
          </div>
        </div>
        <div className="text-right text-xs text-slate-400 font-mono">
          <div>命中規則：<span className="text-slate-200">{decision.decisionPath}</span></div>
          <div>建議部位：<span className="text-slate-200">{sizePct}%</span>
            {sizeAmount && <span className="text-cyan-300 ml-1.5">（≈ {sizeAmount}）</span>}
          </div>
          {sizePct > 0 && totalCapital == null && (
            <div className="text-[10px] text-slate-500 mt-0.5">
              設定 portfolio 總資產後顯示 NT$
            </div>
          )}
        </div>
      </div>

      <p className="text-sm text-slate-300">{decision.verdictReason}</p>

      {/* 4+1 個面向 verdict 並列 */}
      <div className="grid grid-cols-5 gap-2 text-xs">
        <VerdictMini label="技術" v={v.technical} />
        <VerdictMini label="消息" v={v.news} />
        <VerdictMini label="籌碼" v={v.chip} />
        <VerdictMini label="基本" v={v.fundamental} />
        <RiskMini v={v.risk} />
      </div>

      {/* 多空強度 + 進出場參數 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm border-t border-slate-700/50 pt-3">
        <div>
          <div className="text-xs text-slate-400">多空辯論</div>
          <div className="font-mono text-slate-200">
            多 <span className="text-emerald-400">{decision.bullScore}</span>
            <span className="mx-1">vs</span>
            空 <span className="text-rose-400">{decision.bearScore}</span>
          </div>
        </div>
        {decision.entryPrice != null && (
          <div>
            <div className="text-xs text-slate-400">進場價</div>
            <div className="font-mono text-slate-200">{decision.entryPrice}</div>
          </div>
        )}
        {decision.stopLoss != null && (
          <div>
            <div className="text-xs text-slate-400">停損</div>
            <div className="font-mono text-rose-300">{decision.stopLoss}</div>
          </div>
        )}
        {(decision.target1 != null || decision.target2 != null) && (
          <div>
            <div className="text-xs text-slate-400">目標</div>
            <div className="font-mono text-emerald-300">
              {decision.target1 ?? '—'}
              {decision.target2 != null && ` / ${decision.target2}`}
            </div>
          </div>
        )}
      </div>

      {/* 衝突 — 強制顯示 */}
      {decision.conflicts.length > 0 && (
        <div className="border-t border-slate-700/50 pt-3">
          <div className="text-xs font-semibold mb-1 text-amber-300">⚠️ 各代理意見衝突（§0 — 明示不隱藏）</div>
          <ul className="text-xs list-disc ml-5 space-y-0.5 text-slate-300">
            {decision.conflicts.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

const VERDICT_ZH: Record<'pass' | 'watch' | 'fail', string> = {
  pass: '通過', watch: '觀察', fail: '不通過',
};
const RISK_ZH: Record<'green' | 'yellow' | 'red', string> = {
  green: '綠燈', yellow: '黃燈', red: '紅燈',
};

function VerdictMini({ label, v }: { label: string; v: 'pass' | 'watch' | 'fail' | null }) {
  const cfg = v ? {
    pass:  'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50',
    watch: 'bg-amber-900/40 text-amber-300 border border-amber-700/50',
    fail:  'bg-rose-900/40 text-rose-300 border border-rose-700/50',
  }[v] : 'bg-slate-800 text-slate-500 border border-slate-700';
  return (
    <div className={`rounded p-1.5 text-center ${cfg}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="font-semibold">{v ? VERDICT_ZH[v] : '—'}</div>
    </div>
  );
}

function RiskMini({ v }: { v: 'green' | 'yellow' | 'red' | null }) {
  const cfg = v ? {
    green:  'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50',
    yellow: 'bg-amber-900/40 text-amber-300 border border-amber-700/50',
    red:    'bg-rose-900/40 text-rose-300 border border-rose-700/50',
  }[v] : 'bg-slate-800 text-slate-500 border border-slate-700';
  return (
    <div className={`rounded p-1.5 text-center ${cfg}`}>
      <div className="text-xs opacity-80">風控</div>
      <div className="font-semibold">{v ? RISK_ZH[v] : '—'}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Risk Detail
// ────────────────────────────────────────────────────────────────────────────

function RiskDetail({ answer }: { answer: RiskAnswer }) {
  const verdictCfg: Record<RiskAnswer['verdict'], { label: string; cls: string; accent: 'emerald' | 'amber' | 'rose' }> = {
    green:  { label: '🟢 綠燈 — 風險低', cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50', accent: 'emerald' },
    yellow: { label: '🟡 黃燈 — 需警示', cls: 'bg-amber-900/50 text-amber-300 border-amber-700/50',       accent: 'amber' },
    red:    { label: '🔴 紅燈 — 必擋',   cls: 'bg-rose-900/50 text-rose-300 border-rose-700/50',          accent: 'rose' },
  };
  const vc = verdictCfg[answer.verdict];
  return (
    <Panel title="風控代理" accent={vc.accent}>
      <div className="flex items-center gap-3 flex-wrap -mt-1 mb-2">
        <span className={`inline-flex items-center px-3 py-1 rounded-md border text-sm font-semibold ${vc.cls}`}>
          {vc.label}
        </span>
      </div>
      <div className="border border-slate-700 rounded p-3 bg-slate-800/40">
        <p className="font-medium text-slate-100">{zhText(answer.overview)}</p>
        <p className="text-sm text-slate-300 mt-1">{zhText(answer.verdictReason)}</p>
      </div>

      {answer.hardBlockers.length > 0 && (
        <div className="border border-rose-700/50 rounded p-3 bg-rose-900/20 space-y-1">
          <h3 className="font-semibold text-sm text-rose-300">🚫 Hard Blockers（必擋）</h3>
          <ul className="space-y-1">
            {answer.hardBlockers.map((b, i) => (
              <li key={i} className="text-sm flex items-start gap-2 text-slate-300">
                <span className="text-rose-400">●</span>
                {b.ruleId && <span className="font-mono text-xs text-slate-500">{b.ruleId}</span>}
                <span className="flex-1">{b.label}</span>
                <span className="text-xs text-slate-400">[{b.severity}]</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {answer.softWarnings.length > 0 && (
        <div className="border border-amber-700/50 rounded p-3 bg-amber-900/20 space-y-1">
          <h3 className="font-semibold text-sm text-amber-300">⚠️ Soft Warnings</h3>
          <ul className="space-y-1">
            {answer.softWarnings.map((w, i) => (
              <li key={i} className="text-sm flex items-start gap-2 text-slate-300">
                <span className="text-amber-400">●</span>
                <span className="flex-1">{w.label}</span>
                <span className="text-xs text-slate-400">[{w.impact}]</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {answer.events.length > 0 && (
        <div className="border border-cyan-700/50 rounded p-3 bg-cyan-900/20 space-y-1">
          <h3 className="font-semibold text-sm text-cyan-300">📅 即將發生事件</h3>
          <ul className="space-y-1">
            {answer.events.map((e, i) => (
              <li key={i} className="text-sm text-slate-300">
                <span className="font-mono text-xs text-slate-400">{e.date}</span>
                <span className="ml-2 font-medium text-slate-200">{e.type}</span>
                <span className="ml-2">{e.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {answer.suggestedStopLoss != null && (
        <p className="text-sm text-slate-300">
          建議停損價：<span className="font-mono font-semibold text-rose-300">{answer.suggestedStopLoss}</span>
        </p>
      )}
    </Panel>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Bull vs Bear 並排辯論
// ────────────────────────────────────────────────────────────────────────────

function DebateDetail({ bull, bear }: { bull: BullThesis; bear: BearThesis }) {
  const pairs = bull.bullThesis.map((claim, i) => ({
    bullClaim: claim,
    bearRebuttal: bear.rebuttals.find((r) => r.rebuts === i) ?? null,
  }));
  return (
    <Panel title="多空辯論">
      <div className="text-sm font-mono -mt-1 mb-2 text-slate-300">
        多 <span className="text-emerald-400">{bull.totalStrength}</span>
        <span className="mx-1">vs</span>
        空 <span className="text-rose-400">{bear.totalStrength}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm mb-3">
        <div className="border border-emerald-700/50 rounded p-3 bg-emerald-900/20">
          <h3 className="font-semibold text-emerald-300 mb-2">🐂 多方</h3>
          <p className="text-xs text-slate-300">{bull.overview}</p>
        </div>
        <div className="border border-rose-700/50 rounded p-3 bg-rose-900/20">
          <h3 className="font-semibold text-rose-300 mb-2">🐻 空方</h3>
          <p className="text-xs text-slate-300">{bear.overview}</p>
        </div>
      </div>

      <h3 className="text-sm font-medium text-slate-300 mb-2">逐條辯論</h3>
      <div className="space-y-2">
        {pairs.map((p, i) => (
          <div key={i} className="grid grid-cols-1 md:grid-cols-2 gap-0 border border-slate-700 rounded overflow-hidden">
            <div className="p-3 bg-emerald-900/15 border-r border-slate-700">
              <div className="text-xs text-emerald-400 mb-1">
                多方 #{i + 1} · 強度 {p.bullClaim.strength}/5
              </div>
              <p className="text-sm text-slate-200">{p.bullClaim.claim}</p>
              <EvidenceList refs={p.bullClaim.evidence} />
              {p.bullClaim.weaknessAcknowledged && (
                <p className="text-xs text-slate-400 mt-1 italic">
                  自認弱點：{p.bullClaim.weaknessAcknowledged}
                </p>
              )}
            </div>
            <div className="p-3 bg-rose-900/15">
              {p.bearRebuttal ? (
                <>
                  <div className="text-xs text-rose-400 mb-1">
                    空方反駁 · 強度 {p.bearRebuttal.strength}/5
                  </div>
                  <p className="text-sm text-slate-200">{p.bearRebuttal.counter}</p>
                  <EvidenceList refs={p.bearRebuttal.evidence} />
                  {p.bearRebuttal.partialValidity && (
                    <p className="text-xs text-slate-400 mt-1 italic">
                      部分承認：{p.bearRebuttal.partialValidity}
                    </p>
                  )}
                </>
              ) : (
                <div className="text-xs text-slate-500 italic">（空方未反駁）</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {bear.additionalConcerns.length > 0 && (
        <div className="border border-rose-700/50 rounded p-3 bg-rose-900/20 mt-3">
          <h3 className="text-sm font-medium text-rose-300">🐻 空方額外擔憂</h3>
          <ul className="mt-1 space-y-1 text-sm text-slate-300">
            {bear.additionalConcerns.map((c, i) => (
              <li key={i}>
                <span className="font-medium text-rose-400">[{c.strength}/5]</span> {c.concern}
                <EvidenceList refs={c.evidence} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function EvidenceList({ refs }: { refs: BullThesis['bullThesis'][0]['evidence'] }) {
  if (refs.length === 0) {
    return <div className="text-xs text-slate-500 italic mt-1">（無 dataPoint 依據）</div>;
  }
  return (
    <ul className="text-xs text-slate-400 mt-1 space-y-0.5">
      {refs.map((r, i) => (
        <li key={i}>
          📎 <span className="font-mono text-cyan-400">{r.agent}.dp[{r.dataPointIndex}]</span>: {r.label}
        </li>
      ))}
    </ul>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Technical / News / Chip / Fundamental Detail（共用 ReasoningGroup）
// ────────────────────────────────────────────────────────────────────────────

function TechnicalDetail({ answer }: { answer: TechnicalAnswer }) {
  return (
    <Panel title={`技術面 · ${answer.reasoning.length} 段論述`}>
      <div className="flex items-center gap-3 flex-wrap -mt-1 mb-2">
        <VerdictBadge verdict={answer.verdict} />
        {answer.overview && <span className="text-sm text-slate-300 italic">{zhText(answer.overview)}</span>}
      </div>
      <ReasoningGroup
        sections={answer.reasoning}
        labelMap={TECH_SECTION_LABELS as Record<string, string>}
      />
      <DataPointTable points={answer.dataPoints} title="技術面數據" />
      <BookCitationTable cites={answer.bookCitations} />
      {answer.caveat && <CaveatNote text={answer.caveat} />}
    </Panel>
  );
}

function NewsDetail({ answer }: { answer: NewsAnswer }) {
  return (
    <Panel title={`消息面 · ${answer.reasoning.length} 段論述`}>
      <div className="flex items-center gap-3 flex-wrap -mt-1 mb-2">
        <VerdictBadge verdict={answer.verdict} />
        <span className="text-xs text-slate-400">
          {answer.mentioned ? '🔥 進入彙整（combined_confidence ≥ 0.6）' : '— 未進入彙整'}
        </span>
        {answer.overview && <span className="text-sm text-slate-300 italic">{zhText(answer.overview)}</span>}
      </div>
      <ReasoningGroup
        sections={answer.reasoning}
        labelMap={NEWS_SECTION_LABELS as Record<string, string>}
      />
      <DataPointTable points={answer.dataPoints} title="消息面數據" />
      {answer.caveat && <CaveatNote text={answer.caveat} />}
    </Panel>
  );
}

function ChipDetail({ answer, market }: { answer: ChipAnswer; market?: 'TW' | 'CN' | 'other' }) {
  return (
    <Panel title={`籌碼面 · ${answer.reasoning.length} 段論述`}>
      <div className="flex items-center gap-3 flex-wrap -mt-1 mb-2">
        <VerdictBadge verdict={answer.verdict} />
        {answer.overview && <span className="text-sm text-slate-300 italic">{zhText(answer.overview)}</span>}
      </div>
      <ReasoningGroup
        sections={answer.reasoning}
        labelMap={CHIP_SECTION_LABELS as Record<string, string>}
      />
      <DataPointTable points={answer.dataPoints} title="籌碼面數據" />
      {answer.caveat && <CaveatNote text={answer.caveat} />}
      <SellHeavinessReference market={market} className="mt-2" />
    </Panel>
  );
}

function FundamentalDetail({ answer }: { answer: FundamentalAnswer }) {
  return (
    <Panel title={`基本面 · ${answer.reasoning.length} 段論述`}>
      <div className="flex items-center gap-3 flex-wrap -mt-1 mb-2">
        <VerdictBadge verdict={answer.verdict} />
        {answer.overview && <span className="text-sm text-slate-300 italic">{zhText(answer.overview)}</span>}
      </div>
      <ReasoningGroup
        sections={answer.reasoning}
        labelMap={FUNDAMENTAL_SECTION_LABELS as Record<string, string>}
      />
      <DataPointTable points={answer.dataPoints} title="基本面數據" />
      {answer.caveat && <CaveatNote text={answer.caveat} />}
    </Panel>
  );
}

function CaveatNote({ text }: { text: string }) {
  return (
    <div className="border border-amber-700/40 bg-amber-900/15 rounded p-3 text-xs text-amber-200/90 italic">
      ⚠ {zhText(text)}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Shared components
// ────────────────────────────────────────────────────────────────────────────

interface ReasoningItem {
  section: string;
  text: string;
  ruleIds?: string[];
  sources?: string[];
}

function ReasoningGroup({
  sections, labelMap,
}: { sections: ReasoningItem[]; labelMap: Record<string, string> }) {
  return (
    <div className="grid gap-2">
      {sections.map((r, i) => {
        const refs = r.ruleIds ?? r.sources ?? [];
        // 來源若都是 prefetch.xxx 路徑就翻成中文，書本 ruleId（c-/p-/e-/m-/zhu-）保留
        const refsZh = refs.map((ref) =>
          ref.startsWith('prefetch.') || ref.startsWith('groundTruth.') || ref.startsWith('L4.')
            ? zhSource(ref)
            : ref,
        );
        return (
          <details key={r.section} className="border border-slate-700 rounded p-3 bg-slate-800/30" {...(i === 0 ? { open: true } : {})}>
            <summary className="font-medium cursor-pointer flex items-center justify-between gap-2 text-sm text-cyan-300 hover:text-cyan-200 select-none">
              <span>{labelMap[r.section] ?? r.section}</span>
              <span className="text-[10px] text-slate-500 text-right max-w-[60%] truncate" title={refsZh.join(' / ')}>
                {refsZh.length > 0 ? `依據 ${refsZh.length} 條` : ''}
              </span>
            </summary>
            <p className="mt-2 text-sm whitespace-pre-wrap leading-relaxed text-slate-300">{zhText(r.text)}</p>
          </details>
        );
      })}
    </div>
  );
}

const CATEGORY_ZH: Record<string, string> = {
  technical: '技術', news: '消息', chip: '籌碼',
  fundamental: '基本', valuation: '估值', industry: '產業',
  macro: '總經', governance: '治理',
};

function DataPointTable({ points, title }: { points: DataPoint[]; title: string }) {
  return (
    <details className="space-y-1">
      <summary className="text-sm font-medium text-slate-300 cursor-pointer hover:text-slate-100 select-none">
        {title}（{points.length} 筆）
      </summary>
      <div className="overflow-x-auto mt-2">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-slate-800/60 text-slate-400 text-xs uppercase tracking-wider">
              <th className="px-2 py-1.5 text-left font-medium">類別</th>
              <th className="px-2 py-1.5 text-left font-medium">欄位</th>
              <th className="px-2 py-1.5 text-left font-medium">值</th>
              <th className="px-2 py-1.5 text-left font-medium">資料來源</th>
              <th className="px-2 py-1.5 text-left font-medium">日期</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {points.map((p, i) => (
              <tr key={i} className="hover:bg-slate-800/40">
                <td className="px-2 py-1 text-xs text-slate-500">{CATEGORY_ZH[p.category] ?? p.category}</td>
                <td className="px-2 py-1 text-slate-300">{zhLabel(p.label)}</td>
                <td className="px-2 py-1 font-mono text-xs text-slate-100">{p.value}</td>
                <td className="px-2 py-1 text-xs text-slate-400">{zhSource(p.source)}</td>
                <td className="px-2 py-1 text-xs text-slate-400">{p.asOf ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function BookCitationTable({ cites }: { cites: BookCitation[] }) {
  const groups = {
    six: cites.filter((c) => c.ruleId.startsWith('c-')),
    prohibition: cites.filter((c) => c.ruleId.startsWith('p-')),
    elimination: cites.filter((c) => c.ruleId.startsWith('e-')),
    mtf: cites.filter((c) => c.ruleId.startsWith('m-')),
  };
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-slate-300">書本規則引用（{cites.length} 條）</h3>
      <CitationGroup title="六大條件" cites={groups.six} />
      <CitationGroup title="十大戒律" cites={groups.prohibition} />
      <CitationGroup title="淘汰法 R1-R11" cites={groups.elimination} />
      <CitationGroup title="長線保護短線（MTF）" cites={groups.mtf} />
    </div>
  );
}

function CitationGroup({ title, cites }: { title: string; cites: BookCitation[] }) {
  if (cites.length === 0) return null;
  return (
    <details className="border border-slate-700 rounded p-2 bg-slate-800/30" open>
      <summary className="font-medium cursor-pointer text-sm text-slate-300 hover:text-slate-100 select-none">
        {title} <span className="text-xs text-slate-500">({cites.length})</span>
      </summary>
      <ul className="mt-2 space-y-1">
        {cites.map((c) => (
          <li key={c.ruleId} className="flex items-center gap-2 text-sm">
            <span className={c.pass ? 'text-emerald-400' : 'text-rose-400'}>
              {c.pass ? '✓' : '✗'}
            </span>
            <span className="font-mono text-xs text-slate-500 w-12">{c.ruleId}</span>
            <span className="flex-1 text-slate-300">{c.label}</span>
            <span className="text-xs text-slate-400">{zhCitationValue(c.value)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
