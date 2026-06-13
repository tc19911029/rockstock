'use client';

/**
 * YoutubeProgramStocks — /health > YouTube tab 的「各節目談了哪些股票」區塊
 *
 * 把 /api/youtube/performance（以「股票」為主軸）反轉成以「節目」為主軸：
 *   一張卡 = 一個節目（同節目當天多集合併），卡內列出該節目談到的股票，
 *   每檔顯示 立場（看多/看空/觀察/風險/中立＝是否推薦的訊號）＋ 原話（節目裡怎麼說）。
 *
 * 與首頁 YoutubeStocksPanel 同一支 API，純前端 pivot，不動後端 / 不重跑分析。
 * ⚠ 股票資料來自 LLM 分析（/youtube-analysis，每晚 23:55 或手動才寫）；白天看「今日」
 *   常為空（影片抓取健康在傍晚就有，但分析晚上才產生）— 以空狀態文案說明。
 */

import { useEffect, useMemo, useState } from 'react';
import type { PerformanceResponse, PerformanceItem } from '@/app/api/youtube/performance/route';
import type { StockSentiment, StockRating } from '@/lib/youtube/analysisStorage';
import { cleanTeacherNames } from '@/lib/youtube/teacherName';
import { SENTIMENT_LABEL, sentimentRank } from './sentimentLabels';

interface Props {
  /** 'YYYY-MM-DD' — 與 YoutubeTab 共用同一日期 */
  date: string;
}

const RATING_CLASS: Record<string, string> = {
  A: 'bg-green-900/50 text-green-300 border-green-600',
  B: 'bg-blue-900/40 text-blue-300 border-blue-700',
  C: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
  D: 'bg-red-900/40 text-red-300 border-red-700',
};

interface ProgramStock {
  stock_code: string;
  stock_name: string;
  rating?: StockRating;
  sentiment: StockSentiment;
  context: string;
  reason: string;
  video_url: string;
  /** 講這檔的分析師（老師）— 同節目多位老師時用來標「誰講的」*/
  analysts: string[];
  /** 同節目跨集（上/中/下）都提到這檔時 > 1 */
  episodeCount: number;
}

// 分析師顯示名清洗已抽出至 lib/youtube/teacherName.ts（與推薦事件抽取共用同一套規則）
const teachersFor = cleanTeacherNames;

interface ProgramGroup {
  source_id: string;
  display_name: string;
  analysts: string[];
  videos: Array<{ video_id: string; video_title: string; video_url: string }>;
  stocks: ProgramStock[];
}

/**
 * items=股票 → 反轉成 programs=節目（按 source_id 合併當天多集）。
 * 同節目內同一檔股票出現多次 → 去重，保留 sentiment 最強的立場與原話，並計集數。
 */
function pivotByProgram(items: PerformanceItem[]): ProgramGroup[] {
  const groups = new Map<string, ProgramGroup>();
  // 每節目內 stock_code → 已選 mention（指向 groups 內 stocks 陣列共用的物件）
  const stockByProgram = new Map<string, Map<string, ProgramStock>>();

  for (const item of items) {
    for (const src of item.sources) {
      let g = groups.get(src.source_id);
      if (!g) {
        g = { source_id: src.source_id, display_name: src.display_name, analysts: [], videos: [], stocks: [] };
        groups.set(src.source_id, g);
        stockByProgram.set(src.source_id, new Map());
      }
      // distinct 影片（集）
      if (!g.videos.some(v => v.video_id === src.video_id)) {
        g.videos.push({ video_id: src.video_id, video_title: src.video_title, video_url: src.video_url });
      }
      // 分析師 union 去重
      for (const a of src.analysts ?? []) {
        if (a && !g.analysts.includes(a)) g.analysts.push(a);
      }
      // 股票去重（保留 sentiment 最強）+ 計集數
      const acc = stockByProgram.get(src.source_id)!;
      const prev = acc.get(item.stock_code);
      if (!prev) {
        const ps: ProgramStock = {
          stock_code: item.stock_code,
          stock_name: item.stock_name,
          rating: item.rating,
          sentiment: src.sentiment,
          context: src.context,
          reason: src.reason,
          video_url: src.video_url,
          analysts: [...new Set(src.analysts ?? [])],
          episodeCount: 1,
        };
        acc.set(item.stock_code, ps);
        g.stocks.push(ps);
      } else {
        prev.episodeCount += 1;
        // 同檔被同節目多位老師/多集講到 → union 講師（不論立場強弱都留）
        for (const a of src.analysts ?? []) {
          if (!prev.analysts.includes(a)) prev.analysts.push(a);
        }
        if (sentimentRank(src.sentiment) < sentimentRank(prev.sentiment)) {
          prev.sentiment = src.sentiment;
          prev.context = src.context;
          prev.reason = src.reason;
          prev.video_url = src.video_url;
        }
      }
    }
  }

  for (const g of groups.values()) {
    g.stocks.sort(
      (a, b) => sentimentRank(a.sentiment) - sentimentRank(b.sentiment) || a.stock_code.localeCompare(b.stock_code),
    );
  }

  return [...groups.values()].sort(
    (a, b) => b.stocks.length - a.stocks.length || a.display_name.localeCompare(b.display_name),
  );
}

export function YoutubeProgramStocks({ date }: Props) {
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 只在 date 變動時抓 — 股票分析一天寫一次,不需跟 health 一樣 60s 輪詢
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/youtube/performance?date=${encodeURIComponent(date)}`)
      .then(r => r.json())
      .then((json: PerformanceResponse & { ok?: boolean; error?: string }) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); setData(null); return; }
        setData(json);
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  const programs = useMemo(() => pivotByProgram(data?.items ?? []), [data]);
  const totalStocks = useMemo(() => programs.reduce((n, p) => n + p.stocks.length, 0), [programs]);

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">📊 各節目談了哪些股票</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            每個節目分享的個股 · 怎麼說 · 立場（看多＝偏推薦進場）
          </p>
        </div>
        {programs.length > 0 && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {programs.length} 個節目 · {totalStocks} 檔提及
          </span>
        )}
      </div>

      {loading && !data && (
        <div className="text-center py-8 text-sm text-muted-foreground">載入中…</div>
      )}

      {error && (
        <div className="text-sm text-red-400 p-2 border border-red-700/40 rounded">
          載入失敗：{error}
        </div>
      )}

      {!loading && !error && programs.length === 0 && (
        <div className="text-center py-8 space-y-1">
          <p className="text-2xl mb-1">📊</p>
          <p className="text-sm text-muted-foreground">此日 YouTube 分析尚未產生</p>
          <p className="text-[11px] text-muted-foreground/70 max-w-md mx-auto leading-relaxed">
            節目談股資料來自 LLM 分析（每晚 23:55 或手動 <code className="text-foreground">/youtube-analysis</code> 後才寫入）。
            上方影片表是「抓取狀態」、會較早出現；切到較早日期可看已分析的節目談股紀錄。
          </p>
        </div>
      )}

      {programs.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {programs.map(p => <ProgramCard key={p.source_id} program={p} />)}
        </div>
      )}
    </div>
  );
}

function ProgramCard({ program }: { program: ProgramGroup }) {
  // 該節目的講師名單（清掉「(節目名)」括號 + fallback）；≥2 位才逐檔標「誰講的」
  const programTeachers = teachersFor(program.analysts, program.display_name);
  const multiTeacher = programTeachers.length >= 2;

  return (
    <div className="rounded-lg border border-border/60 bg-secondary/20 p-3 space-y-2">
      {/* 卡頭：節目名 + 講師群 + 檔數 + 影片連結（多集列多個） */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-foreground">📺 {program.display_name}</span>
        {programTeachers.length > 0 && (
          <span className="text-[11px] text-amber-400">【{programTeachers.join('/')}】</span>
        )}
        <span className="text-[11px] text-muted-foreground">{program.stocks.length} 檔</span>
        <span className="ml-auto flex items-center gap-2">
          {program.videos.map((v, i) => (
            <a
              key={v.video_id}
              href={v.video_url}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-sky-400 hover:underline whitespace-nowrap"
              title={v.video_title}
            >
              看影片{program.videos.length > 1 ? ` ${i + 1}` : ''} ↗
            </a>
          ))}
        </span>
      </div>

      {/* 卡身：每檔股票一列 — 代號(連走圖) + 名稱 + rating + 立場 + 原話 */}
      <div className="space-y-1.5">
        {program.stocks.map(s => {
          const lbl = SENTIMENT_LABEL[s.sentiment] ?? SENTIMENT_LABEL.mentioned_only;
          const quote = s.context || s.reason || '';
          // 多老師節目才逐檔標「誰講的」；單一主持已在卡頭，不重複
          const teachers = multiTeacher ? teachersFor(s.analysts, program.display_name) : [];
          return (
            <div key={s.stock_code} className="border-l-2 border-border/50 pl-2 py-0.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                {teachers.length > 0 && (
                  <span className="text-[10px] text-amber-400 font-medium" title="這檔由誰介紹">
                    {teachers.join('、')}
                  </span>
                )}
                <a
                  href={`/?load=${s.stock_code}`}
                  className="font-mono text-[11px] text-sky-300 hover:underline"
                  title="在首頁載入此股 K 線"
                >
                  {s.stock_code}
                </a>
                <span className="text-[11px] text-foreground/80">{s.stock_name}</span>
                {s.rating && (
                  <span className={`text-[9px] px-1 h-3.5 flex items-center rounded-sm border font-bold ${RATING_CLASS[s.rating] ?? ''}`}>
                    {s.rating}
                  </span>
                )}
                <span className={`text-[10px] font-bold ${lbl.cls}`}>〔{lbl.text}〕</span>
                {s.episodeCount > 1 && (
                  <span className="text-[9px] text-muted-foreground">×{s.episodeCount} 集</span>
                )}
              </div>
              {quote && (
                <div className="text-[10px] text-foreground/70 leading-snug line-clamp-2 mt-0.5" title={quote}>
                  「{quote}」
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
