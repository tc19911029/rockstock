/**
 * 世芯-KY (3661) × CMoney 同學會 jasmine777 發文 → 股價變化 對照表
 * ============================================================================
 *
 * 目的：把 jasmine777（CMoney 會員 14459827）在 3661 世芯-KY 板的每一篇發文，
 *       對照「發文後」股價的變化（T+1 / T+5 / T+10 / T+20 交易日報酬，
 *       以及發文後 20 交易日內的最大漲幅 / 最大回檔），看「發完文後股價怎麼走」。
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
 *            "postedAt": "2026-03-27T09:12:00+08:00" },
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
 *   # 嘗試 live 抓（多半要 cookie；失敗會明確告訴你改用 --input）
 *   CMONEY_COOKIE='...' npx tsx scripts/jasmine777-correlation.ts --live
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
interface Post {
  id: string;
  title: string;
  postedAt: string; // ISO，已正規化為 +08:00
  url: string;
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
  const a: { input?: string; from?: string; to?: string; live?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--input') a.input = argv[++i];
    else if (k === '--from') a.from = argv[++i];
    else if (k === '--to') a.to = argv[++i];
    else if (k === '--live') a.live = true;
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
    posts.push({
      id,
      title: title || '(無標題)',
      postedAt,
      url: it.url ?? `https://www.cmoney.tw/forum/article/${id}`,
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

function toMarkdown(rows: Row[]): string {
  const head = `| 發文日 | 對齊交易日 | 標題 | 發文前收 | 發文日收 | ${HORIZONS.map((h) => `T+${h}`).join(' | ')} | 20日最大漲 | 20日最大回 |`;
  const sep = `|---|---|---|---|---|${HORIZONS.map(() => '---').join('|')}|---|---|`;
  const body = rows
    .map((r) => {
      const title = r.post.title.length > 22 ? r.post.title.slice(0, 22) + '…' : r.post.title;
      return `| ${r.postDate} | ${r.baseDate} | ${title} | ${r.prevClose ?? '—'} | ${r.baseClose} | ${HORIZONS.map(
        (h) => fmt(r.forward[h], '%'),
      ).join(' | ')} | ${fmt(r.maxGainPct, '%')} | ${fmt(r.maxDrawPct, '%')} |`;
    })
    .join('\n');
  return [head, sep, body].join('\n');
}

function summarize(rows: Row[]): string {
  const lines: string[] = ['', '── 彙總（發文後表現）──'];
  for (const h of HORIZONS) {
    const vals = rows.map((r) => r.forward[h]).filter((v): v is number => v != null);
    if (!vals.length) continue;
    const avg = +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2);
    const win = +((vals.filter((v) => v > 0).length / vals.length) * 100).toFixed(1);
    const med = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
    lines.push(`T+${h}：樣本 ${vals.length}　平均 ${fmt(avg, '%')}　中位 ${fmt(med, '%')}　上漲率 ${win}%`);
  }
  return lines.join('\n');
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

  // 2) 股價（涵蓋最早發文前 5 天 ~ 最晚發文後 ~40 曆天，確保 T+20 交易日覆蓋）
  const dates = posts.map((p) => ymdTaipei(p.postedAt)).sort();
  const start = shiftDate(dates[0], -7);
  const end = shiftDate(dates[dates.length - 1], 45);
  console.log(`抓 ${SYMBOL} 日K：${start} ~ ${end} …`);
  const candles = await dataProvider.getCandlesRange(SYMBOL, start, end);
  console.log(`取得 ${candles.length} 根日K`);
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
