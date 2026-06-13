/**
 * 世芯-KY (3661) × CMoney 同學會 jasmine777 發文 → 股價變化 對照表
 * ============================================================================
 *
 * 目的：把 jasmine777（CMoney 會員 14459827）在 3661 世芯-KY 板的每一篇發文，
 *       對照「發文後」股價的變化（T+1 / T+5 / T+10 / T+20 交易日報酬，
 *       以及發文後 20 交易日內的最大漲幅 / 最大回檔），看「發完文後股價怎麼走」。
 *
 *       進階：每篇帶「發文情緒」(看多/看空/中性)，彙總會「依情緒分組」算發文後報酬，
 *       並算「情緒分數 ↔ 發文後報酬」的相關係數，回答『她的情緒對股價的影響』。
 *       情緒優先吃 input 的 sentiment 欄位；沒給才用標題關鍵字啟發式推估（弱訊號，標 ?）。
 *
 * 為什麼分兩段（發文清單 ←→ 股價）：
 *   CMoney forum 有反爬蟲（雲端環境直接 fetch 會 403）。所以：
 *     - 股價：走 repo 既有 dataProvider（TWSE/FinMind/Yahoo fallback 鏈，免 key、穩定）
 *     - 發文清單：優先吃 --input 檔（你從瀏覽器存下來，100% 可行），
 *                 沒給才嘗試 live 抓 CMoney（多半需要 cookie，當 best-effort）
 *
 * ── 取得發文清單（--input）的最穩做法 ───────────────────────────────────────
 *   1. 瀏覽器登入後開 https://www.cmoney.tw/forum/user/14459827
 *   2. F12 → Network → 往下捲動讓它載入文章 → 找回傳文章陣列的 XHR
 *      （回應裡每筆有 articleId / 標題 / createTime 之類欄位）
 *   3. 把該 XHR 的 JSON 回應整包存成檔，或自己整理成下面格式都可：
 *        [
 *          { "id": "177745454",
 *            "title": "人間四月芳菲盡 山寺桃花始盛開 做頭明顯或打底完成意會？",
 *            "postedAt": "2026-03-27T09:12:00+08:00",
 *            "sentiment": "bullish" },   // 選填：bullish/bearish/neutral 或 +1/-1/0；省略則用標題推估
 *          ...
 *        ]
 *      postedAt 可以是 ISO 字串或 epoch 毫秒；本腳本會自動辨識 CMoney 常見欄位名
 *      （articleId/id、title/subject、createTime/createTimeText/publishTime…）。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   # 用你存下來的發文清單（建議）
 *   npx tsx scripts/jasmine777-correlation.ts --input ./jasmine777-posts.json
 *
 *   # 只算某段期間
 *   npx tsx scripts/jasmine777-correlation.ts --input posts.json --from 2026-01-01
 *
 *   # 用本地日K檔(離線；網路被擋時)。檔案為 [{date,open,high,low,close,volume}] JSON
 *   npx tsx scripts/jasmine777-correlation.ts --input posts.json --prices candles.json
 *
 *   # 嘗試 live 抓（多半要 cookie；失敗會明確告訴你改用 --input）
 *   CMONEY_COOKIE='...' npx tsx scripts/jasmine777-correlation.ts --live
 *
 *   # 進階情緒分析：先產「待標情緒工作表」→ 讀完內文逐篇標 sentiment → 再跑分析
 *   npx tsx scripts/jasmine777-correlation.ts --input posts.json --emit-labels labels.json
 *   #   (填好 labels.json 的 sentiment 後)
 *   npx tsx scripts/jasmine777-correlation.ts --input labels.json
 *
 * 輸出：
 *   data/reports/jasmine777-3661-correlation.csv
 *   data/reports/jasmine777-3661-correlation.json
 *   並在終端印出 markdown 對照表 + 彙總統計（命中率 / 平均報酬）
 */

import { promises as fs } from 'fs';
import path from 'path';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import type { Candle } from '@/types';

// ── 設定 ─────────────────────────────────────────────────────────────────────
const SYMBOL = '3661.TW';
const STOCK_NAME = '世芯-KY';
const USER_ID = '14459827';
const USER_NAME = 'jasmine777';
const HORIZONS = [1, 5, 10, 20]; // forward 交易日
const MAX_EXCURSION_WINDOW = 20; // 計算最大漲幅/回檔的窗口（交易日）
const OUT_DIR = 'data/reports';

// ── 型別 ─────────────────────────────────────────────────────────────────────
type Sentiment = 'bullish' | 'bearish' | 'neutral';

interface Post {
  id: string;
  title: string;
  postedAt: string; // ISO，已正規化為 +08:00
  url: string;
  sentiment: Sentiment; // 發文情緒：看多/看空/中性
  sentimentScore: number; // 啟發式分數（>0 偏多，<0 偏空）
  sentimentSource: 'input' | 'heuristic'; // 來源：input 欄位 or 標題關鍵字推估
}

interface Row {
  post: Post;
  postDate: string; // YYYY-MM-DD (Taipei)
  baseDate: string; // 對齊到的交易日 (T0)
  prevClose: number | null; // T-1 收盤（發文前一日，看是不是追高/抄底）
  baseClose: number; // T0 收盤
  baseDayChangePct: number | null; // T0 當日 (close-open)/open，發文日日內
  forward: Record<number, number | null>; // T+h 相對 baseClose 報酬 %
  maxGainPct: number | null; // 發文後 20 交易日內最大漲幅 (vs baseClose)
  maxDrawPct: number | null; // 發文後 20 交易日內最大回檔 (vs baseClose)
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const a: { input?: string; from?: string; to?: string; live?: boolean; emitLabels?: string; prices?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--input') a.input = argv[++i];
    else if (k === '--from') a.from = argv[++i];
    else if (k === '--to') a.to = argv[++i];
    else if (k === '--live') a.live = true;
    else if (k === '--emit-labels') a.emitLabels = argv[++i] ?? 'docs/jasmine777-labels.todo.json';
    else if (k === '--prices') a.prices = argv[++i]; // 本地日K檔(JSON: [{date,open,high,low,close,volume}])，跳過網路 provider
  }
  return a;
}

// ── 日期工具 ─────────────────────────────────────────────────────────────────
function ymdTaipei(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(iso));
}

/** 把各種 createTime 表示法正規化成 ISO(+08:00) 字串 */
function normalizePostedAt(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    // epoch 秒 or 毫秒
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  const s = String(v).trim();
  if (!s) return null;
  // 純數字字串 → epoch
  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length <= 10 ? Number(s) * 1000 : Number(s);
    return new Date(ms).toISOString();
  }
  // "2026-03-27 09:12:00" → 視為台北時間
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se ?? '00'}+08:00`).toISOString();
  }
  // "2026-03-27"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00+08:00`).toISOString();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ── 情緒判定 ─────────────────────────────────────────────────────────────────
// 優先吃 input 的情緒欄位；沒給才用標題關鍵字啟發式推估（標題訊號弱，僅供分組參考）。
const BULLISH_KW = [
  '看多', '多方', '上漲', '噴', '突破', '起漲', '創高', '新高', '上看', '目標',
  '信仰', '加碼', '進場', '守住', '撐', '低點', '打底', '落底', '觸底', '谷底',
  '消散', '利多', '看好', '回升', '反彈', '軋空', '心中無股價', '王', '無庸置疑',
  '❤', '💪', '🚀', '強',
];
const BEARISH_KW = [
  '看空', '空方', '下跌', '崩', '套牢', '套', '賣壓', '出貨', '風險', '停損',
  '走弱', '做頭', '高檔', '過熱', '利空', '看壞', '小心', '警訊', '崩跌', '修正',
  '回檔', '觀望', '賣', '😓',
];

/** 把外部情緒字串/數字正規化成 Sentiment */
function parseSentimentField(v: unknown): { s: Sentiment; score: number } | null {
  if (v == null) return null;
  if (typeof v === 'number') return { s: v > 0 ? 'bullish' : v < 0 ? 'bearish' : 'neutral', score: v };
  const t = String(v).trim().toLowerCase();
  if (!t) return null;
  if (/^(bull|bullish|多|看多|偏多|positive|pos|\+)/.test(t)) return { s: 'bullish', score: 1 };
  if (/^(bear|bearish|空|看空|偏空|negative|neg|-)/.test(t)) return { s: 'bearish', score: -1 };
  if (/^(neutral|中性|觀望|0)/.test(t)) return { s: 'neutral', score: 0 };
  return null;
}

/** 標題關鍵字啟發式情緒（弱訊號） */
function classifyTitle(title: string): { s: Sentiment; score: number } {
  let score = 0;
  for (const kw of BULLISH_KW) if (title.includes(kw)) score += 1;
  for (const kw of BEARISH_KW) if (title.includes(kw)) score -= 1;
  return { s: score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral', score };
}

// ── 讀發文清單：--input（容錯解析 CMoney 各種欄位名）─────────────────────────
async function loadPostsFromInput(file: string): Promise<Post[]> {
  const raw = await fs.readFile(path.resolve(file), 'utf-8');
  const json = JSON.parse(raw);

  // 從可能巢狀的結構裡挖出文章陣列
  const arr: any[] = Array.isArray(json)
    ? json
    : json.data?.articles ?? json.articles ?? json.data ?? json.list ?? json.items ?? [];
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('--input 檔裡找不到文章陣列（試過 root / data.articles / articles / data / list / items）');
  }

  const posts: Post[] = [];
  for (const it of arr) {
    const id = String(it.id ?? it.articleId ?? it.article_id ?? it.ArticleId ?? '').trim();
    const title = String(it.title ?? it.subject ?? it.Subject ?? it.content ?? '').replace(/\s+/g, ' ').trim();
    const postedAt = normalizePostedAt(
      it.postedAt ?? it.createTime ?? it.createTimeText ?? it.publishTime ?? it.CreateTime ?? it.date ?? it.time,
    );
    if (!id || !postedAt) continue;

    const fromField = parseSentimentField(it.sentiment ?? it.stance ?? it.mood ?? it.bias);
    const cls = fromField ?? classifyTitle(title);
    posts.push({
      id,
      title: title || '(無標題)',
      postedAt,
      url: it.url ?? `https://www.cmoney.tw/forum/article/${id}`,
      sentiment: cls.s,
      sentimentScore: cls.score,
      sentimentSource: fromField ? 'input' : 'heuristic',
    });
  }
  if (posts.length === 0) {
    throw new Error('解析到 0 篇有效發文（需要 id + 可辨識的時間欄位）');
  }
  return posts;
}

// ── 讀發文清單：--live（best-effort，多半需 cookie）─────────────────────────
async function loadPostsLive(): Promise<Post[]> {
  const cookie = process.env.CMONEY_COOKIE ?? '';
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-TW,zh;q=0.9',
    Referer: `https://www.cmoney.tw/forum/user/${USER_ID}`,
  };
  if (cookie) headers.Cookie = cookie;

  // 候選端點（CMoney 介面會變；可自行加）。任一回得到 JSON 陣列就採用。
  const candidates = [
    `https://www.cmoney.tw/forum/api/Article/UserArticleList?targetMemberId=${USER_ID}&fetchSize=300`,
    `https://api.cmoney.tw/forum/api/Article/UserArticleList?targetMemberId=${USER_ID}&fetchSize=300`,
    `https://www.cmoney.tw/forum/user/${USER_ID}`, // SSR HTML，挖 __NEXT_DATA__ / 內嵌 JSON
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        console.warn(`[live] ${res.status} ${url}`);
        continue;
      }
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // 從 HTML 挖內嵌 JSON
        const m =
          text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) ||
          text.match(/__NUXT__\s*=\s*([\s\S]*?);?\s*<\/script>/);
        if (m) {
          try {
            json = JSON.parse(m[1]);
          } catch {
            /* ignore */
          }
        }
      }
      if (!json) continue;
      // 丟給 input 解析器（同一套容錯邏輯）
      const tmp = path.join(process.cwd(), '.tmp-cmoney-live.json');
      await fs.writeFile(tmp, JSON.stringify(json));
      const posts = await loadPostsFromInput(tmp).catch(() => [] as Post[]);
      await fs.rm(tmp, { force: true });
      if (posts.length) {
        console.log(`[live] 取得 ${posts.length} 篇（${url}）`);
        return posts;
      }
    } catch (e) {
      console.warn(`[live] fetch 失敗 ${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    'live 抓取失敗（反爬蟲/需登入 cookie/端點已變）。請改用 --input：' +
      '瀏覽器登入後開 user 頁，F12 Network 存下文章列表 XHR 的 JSON。',
  );
}

// ── 對照計算 ─────────────────────────────────────────────────────────────────
function pct(from: number, to: number): number {
  return +(((to - from) / from) * 100).toFixed(2);
}

function buildRows(posts: Post[], candles: Candle[]): Row[] {
  const sorted = [...candles].sort((a, b) => a.date.localeCompare(b.date));
  const dateIdx = new Map<string, number>();
  sorted.forEach((c, i) => dateIdx.set(c.date, i));

  /** 對齊到第一個 >= 發文日 的交易日 index */
  function alignIdx(postDate: string): number {
    const exact = dateIdx.get(postDate);
    if (exact != null) return exact;
    for (let i = 0; i < sorted.length; i++) if (sorted[i].date >= postDate) return i;
    return -1;
  }

  const rows: Row[] = [];
  for (const post of posts) {
    const postDate = ymdTaipei(post.postedAt);
    const baseIdx = alignIdx(postDate);
    if (baseIdx < 0) continue; // 發文日晚於資料尾端（資料還沒到），略過
    const t0 = sorted[baseIdx];

    const forward: Record<number, number | null> = {};
    for (const h of HORIZONS) {
      const t = sorted[baseIdx + h];
      forward[h] = t ? pct(t0.close, t.close) : null;
    }

    // 20 交易日內最大漲幅 / 最大回檔（用 high/low，更貼近實際走勢）
    let maxGain: number | null = null;
    let maxDraw: number | null = null;
    for (let i = baseIdx + 1; i <= baseIdx + MAX_EXCURSION_WINDOW && i < sorted.length; i++) {
      const g = pct(t0.close, sorted[i].high);
      const d = pct(t0.close, sorted[i].low);
      maxGain = maxGain == null ? g : Math.max(maxGain, g);
      maxDraw = maxDraw == null ? d : Math.min(maxDraw, d);
    }

    rows.push({
      post,
      postDate,
      baseDate: t0.date,
      prevClose: baseIdx > 0 ? sorted[baseIdx - 1].close : null,
      baseClose: t0.close,
      baseDayChangePct: t0.open ? pct(t0.open, t0.close) : null,
      forward,
      maxGainPct: maxGain,
      maxDrawPct: maxDraw,
    });
  }
  // 依發文日排序（新到舊）
  rows.sort((a, b) => b.post.postedAt.localeCompare(a.post.postedAt));
  return rows;
}

// ── 輸出 ─────────────────────────────────────────────────────────────────────
function fmt(n: number | null, suffix = ''): string {
  return n == null ? '—' : `${n > 0 ? '+' : ''}${n}${suffix}`;
}

function toCsv(rows: Row[]): string {
  const head = [
    'post_date',
    'base_trading_day',
    'title',
    'sentiment',
    'sentiment_score',
    'sentiment_source',
    'url',
    'prev_close',
    'base_close',
    'base_day_intraday_%',
    ...HORIZONS.map((h) => `T+${h}_%`),
    'max_gain_20d_%',
    'max_draw_20d_%',
  ];
  const lines = rows.map((r) =>
    [
      r.postDate,
      r.baseDate,
      `"${r.post.title.replace(/"/g, '""')}"`,
      r.post.sentiment,
      r.post.sentimentScore,
      r.post.sentimentSource,
      r.post.url,
      r.prevClose ?? '',
      r.baseClose,
      r.baseDayChangePct ?? '',
      ...HORIZONS.map((h) => r.forward[h] ?? ''),
      r.maxGainPct ?? '',
      r.maxDrawPct ?? '',
    ].join(','),
  );
  return [head.join(','), ...lines].join('\n');
}

const SENT_LABEL: Record<Sentiment, string> = { bullish: '多', bearish: '空', neutral: '中' };

function toMarkdown(rows: Row[]): string {
  const head = `| 發文日 | 對齊交易日 | 情緒 | 標題 | 發文日收 | ${HORIZONS.map((h) => `T+${h}`).join(' | ')} | 20日最大漲 | 20日最大回 |`;
  const sep = `|---|---|---|---|---|${HORIZONS.map(() => '---').join('|')}|---|---|`;
  const body = rows
    .map((r) => {
      const title = r.post.title.length > 20 ? r.post.title.slice(0, 20) + '…' : r.post.title;
      const sent = `${SENT_LABEL[r.post.sentiment]}${r.post.sentimentSource === 'heuristic' ? '?' : ''}`;
      return `| ${r.postDate} | ${r.baseDate} | ${sent} | ${title} | ${r.baseClose} | ${HORIZONS.map(
        (h) => fmt(r.forward[h], '%'),
      ).join(' | ')} | ${fmt(r.maxGainPct, '%')} | ${fmt(r.maxDrawPct, '%')} |`;
    })
    .join('\n');
  return [head, sep, body].join('\n');
}

function statLine(label: string, vals: number[]): string {
  if (!vals.length) return `${label}：無樣本`;
  const avg = +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2);
  const med = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  const win = +((vals.filter((v) => v > 0).length / vals.length) * 100).toFixed(1);
  return `${label}：樣本 ${vals.length}　平均 ${fmt(avg, '%')}　中位 ${fmt(med, '%')}　上漲率 ${win}%`;
}

/** Pearson 相關係數 */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : +(num / den).toFixed(3);
}

function summarize(rows: Row[]): string {
  const lines: string[] = ['', '── 彙總①：發文後整體表現 ──'];
  for (const h of HORIZONS) {
    lines.push(statLine(`T+${h}`, rows.map((r) => r.forward[h]).filter((v): v is number => v != null)));
  }

  // ②：依「發文情緒」分組看後續報酬（核心：情緒 → 股價影響）
  lines.push('', '── 彙總②：發文情緒 × 發文後報酬 ──');
  const groups: Sentiment[] = ['bullish', 'bearish', 'neutral'];
  for (const g of groups) {
    const grp = rows.filter((r) => r.post.sentiment === g);
    if (!grp.length) continue;
    const heu = grp.filter((r) => r.post.sentimentSource === 'heuristic').length;
    lines.push(`【${SENT_LABEL[g]}】共 ${grp.length} 篇${heu ? `（其中 ${heu} 篇情緒為標題推估，信心較低）` : ''}`);
    for (const h of HORIZONS) {
      lines.push('  ' + statLine(`T+${h}`, grp.map((r) => r.forward[h]).filter((v): v is number => v != null)));
    }
  }

  // ③：情緒分數 ↔ 發文後報酬 的相關性
  lines.push('', '── 彙總③：情緒分數 ↔ 發文後報酬 相關性（Pearson r）──');
  for (const h of HORIZONS) {
    const pairs = rows
      .map((r) => ({ x: r.post.sentimentScore, y: r.forward[h] }))
      .filter((p): p is { x: number; y: number } => p.y != null);
    const r = pearson(pairs.map((p) => p.x), pairs.map((p) => p.y));
    lines.push(`T+${h}：r = ${r == null ? '—(樣本不足)' : r}　(n=${pairs.length})`);
  }
  lines.push(
    'r>0：情緒越偏多、發文後越漲（她有領先訊號）；r<0：越偏多反而越跌（情緒常見頂/反指標）；r≈0：無明顯關聯。',
    '註：情緒標 ? 者為標題關鍵字推估，弱訊號；要準請在 input 補 sentiment 欄位（bullish/bearish/neutral 或 +1/-1）。',
  );
  return lines.join('\n');
}

// ── 情緒標註工作表（給人/對話裡的 Claude 讀完內文回填）─────────────────────
async function writeLabelingWorksheet(posts: Post[], outPath: string): Promise<void> {
  const worksheet = {
    _labeling_guide: [
      '這是 jasmine777 發文的「情緒標註工作表」。請逐篇打開 url 讀完內文，在 sentiment 填：',
      '  bullish=看多 / bearish=看空 / neutral=中性陳述或多空夾雜。也可用數字 +1 / -1 / 0。',
      '判定原則(看內文不是只看標題)：對股價/後市的方向性看法為準；純消息整理、抒情、回酸民→neutral。',
      '可順手補 summary(一句話重點) 與 key_points(條列)，分析時更好回顧；非必填。',
      '填完存檔後，這個檔本身就是合法 --input：npx tsx scripts/jasmine777-correlation.ts --input ' + outPath,
      'sentiment 留空的篇數，跑分析時會自動退回標題關鍵字推估(標?，信心較低)。',
    ],
    articles: posts.map((p) => ({
      id: p.id,
      postedAt: p.postedAt,
      url: p.url,
      title: p.title,
      sentiment: '', // ← 讀完內文填 bullish/bearish/neutral
      sentiment_suggested: p.sentiment, // 標題啟發式建議(僅參考)
      summary: '',
      key_points: [] as string[],
    })),
  };
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), JSON.stringify(worksheet, null, 2), 'utf-8');
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`\n=== ${STOCK_NAME}(${SYMBOL}) × CMoney ${USER_NAME}(${USER_ID}) 發文→股價 對照 ===\n`);

  // 1) 發文清單
  let posts: Post[];
  if (args.input) {
    posts = await loadPostsFromInput(args.input);
    console.log(`發文清單：--input 讀到 ${posts.length} 篇`);
  } else if (args.live) {
    posts = await loadPostsLive();
  } else {
    console.error(
      '請提供發文清單：\n' +
        '  --input <file.json>  （建議；見檔頭說明如何從瀏覽器存下）\n' +
        '  --live               （嘗試 live 抓，多半需 CMONEY_COOKIE）\n',
    );
    process.exit(1);
    return;
  }

  // 期間過濾
  if (args.from) posts = posts.filter((p) => ymdTaipei(p.postedAt) >= args.from!);
  if (args.to) posts = posts.filter((p) => ymdTaipei(p.postedAt) <= args.to!);
  if (!posts.length) {
    console.error('過濾後沒有發文。');
    process.exit(1);
    return;
  }

  // 1.5) 只產情緒標註工作表就收工（不抓價）
  if (args.emitLabels) {
    await writeLabelingWorksheet(posts, args.emitLabels);
    console.log(
      `已輸出情緒標註工作表 (${posts.length} 篇)：${args.emitLabels}\n` +
        `→ 逐篇讀完內文把 sentiment 填上(bullish/bearish/neutral)，存檔後：\n` +
        `   npx tsx scripts/jasmine777-correlation.ts --input ${args.emitLabels}\n`,
    );
    return;
  }

  // 2) 股價（涵蓋最早發文前 5 天 ~ 最晚發文後 ~40 曆天，確保 T+20 交易日覆蓋）
  const dates = posts.map((p) => ymdTaipei(p.postedAt)).sort();
  const start = shiftDate(dates[0], -7);
  const end = shiftDate(dates[dates.length - 1], 45);
  let candles: Candle[];
  if (args.prices) {
    // 本地日K檔模式（離線；網路被擋時用）
    const raw = JSON.parse(await fs.readFile(path.resolve(args.prices), 'utf-8'));
    candles = (Array.isArray(raw) ? raw : raw.candles ?? []).map((c: any) => ({
      date: String(c.date).slice(0, 10),
      open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +(c.volume ?? 0),
    }));
    const cov = candles.length ? `${candles[0].date} ~ ${candles[candles.length - 1].date}` : '空';
    console.log(`本地日K：${args.prices}（${candles.length} 根，${cov}）`);
  } else {
    console.log(`抓 ${SYMBOL} 日K：${start} ~ ${end} …`);
    candles = await dataProvider.getCandlesRange(SYMBOL, start, end);
    console.log(`取得 ${candles.length} 根日K`);
  }
  if (candles.length < 2) {
    console.error('日K 不足，無法對照。檢查 dataProvider / 網路 / FINMIND_API_TOKEN。');
    process.exit(1);
    return;
  }

  // 3) 對照
  const rows = buildRows(posts, candles);
  console.log(`\n${toMarkdown(rows)}`);
  console.log(summarize(rows));

  // 4) 落地
  await fs.mkdir(OUT_DIR, { recursive: true });
  const csvPath = path.join(OUT_DIR, 'jasmine777-3661-correlation.csv');
  const jsonPath = path.join(OUT_DIR, 'jasmine777-3661-correlation.json');
  await fs.writeFile(csvPath, toCsv(rows), 'utf-8');
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      { symbol: SYMBOL, stockName: STOCK_NAME, user: USER_NAME, userId: USER_ID, generatedAt: new Date().toISOString(), rows },
      null,
      2,
    ),
    'utf-8',
  );
  console.log(`\n已輸出：\n  ${csvPath}\n  ${jsonPath}\n`);
}

function shiftDate(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

main().catch((e) => {
  console.error('\n[失敗]', e instanceof Error ? e.message : e);
  process.exit(1);
});
