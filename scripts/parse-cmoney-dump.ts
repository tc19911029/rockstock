/**
 * parse-cmoney-dump.ts — 把瀏覽器 DOM dump 的 CMoney 發文，轉成
 * jasmine777-correlation.ts 吃的 --input 格式（含日期正規化 + 內文情緒啟發式）。
 *
 * 輸入：瀏覽器 console 擷取片段下載的 raw dump（陣列）：
 *   [{ id, title, datetime, meta }]   // meta = "暱稱 追蹤 Lv.NN [日期] 世芯-KY [內文…]"
 * 它的 title 其實常是「時間字串」，真正日期+內文都在 meta，本腳本負責拆出來。
 *
 * 日期格式（實測）：
 *   "YYYY年MM月DD日 HH:mm"  → 非當年度貼文（含完整年）
 *   "MM月DD日 HH:mm"        → 當年度貼文（補今年）
 *   "昨天/前天/今天 HH:mm"  → 相對今天
 *   "星期一..日 HH:mm"      → 本週最近一次該星期幾
 *   "N天前 / N小時前"       → 相對今天
 *
 * 情緒：依「內文預覽」關鍵字加權推估（bullish/bearish/neutral），標 sentiment_auto=true。
 *   ⚠️ 預覽僅 ~180 字、且她常把利空講成利多，務必人工抽查/覆蓋。
 *
 * 用法：
 *   npx tsx scripts/parse-cmoney-dump.ts --in jasmine777.json --out docs/jasmine777-labels.full.json
 *   # 指定基準日（相對日期換算用，預設今天台北）
 *   npx tsx scripts/parse-cmoney-dump.ts --in dump.json --out out.json --today 2026-06-13
 */

import { promises as fs } from 'fs';
import path from 'path';

interface RawEntry {
  id: string;
  title?: string;
  datetime?: string;
  meta?: string;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const a: { in?: string; out?: string; today?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') a.in = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--today') a.today = argv[++i];
  }
  return a;
}

function todayTaipei(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

// ── 日期解析 ─────────────────────────────────────────────────────────────────
const WEEKDAY: Record<string, number> = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function isoFromParts(y: number, mo: number, d: number, h = 12, mi = 0): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00+08:00`;
}

function shiftYmd(ymd: string, days: number): string {
  const dt = new Date(ymd + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().split('T')[0];
}

/** 從 meta 的日期 token 解析成 ISO(+08:00)；解析不出回 null */
function parseDateToken(token: string, today: string): string | null {
  const t = token.trim();
  const curYear = +today.slice(0, 4);

  let m = t.match(/^(\d{4})年(\d{2})月(\d{2})日(?:\s+(\d{2}):(\d{2}))?/);
  if (m) return isoFromParts(+m[1], +m[2], +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);

  m = t.match(/^(\d{2})月(\d{2})日(?:\s+(\d{2}):(\d{2}))?/);
  if (m) return isoFromParts(curYear, +m[1], +m[2], m[3] ? +m[3] : 12, m[4] ? +m[4] : 0);

  m = t.match(/^(昨天|前天|今天)(?:\s+(\d{2}):(\d{2}))?/);
  if (m) {
    const off = m[1] === '昨天' ? -1 : m[1] === '前天' ? -2 : 0;
    const d = shiftYmd(today, off);
    return isoFromParts(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10), m[2] ? +m[2] : 12, m[3] ? +m[3] : 0);
  }

  m = t.match(/^星期([日一二三四五六])(?:\s+(\d{2}):(\d{2}))?/);
  if (m) {
    const target = WEEKDAY[m[1]];
    let d = today;
    // 往回找最近一次（含今天）該星期幾
    for (let i = 0; i < 7; i++) {
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      if (dow === target) break;
      d = shiftYmd(d, -1);
    }
    return isoFromParts(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10), m[2] ? +m[2] : 12, m[3] ? +m[3] : 0);
  }

  m = t.match(/^(\d+)\s*天前/);
  if (m) {
    const d = shiftYmd(today, -+m[1]);
    return isoFromParts(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10));
  }
  if (/小時前|分鐘前|分前|秒前|剛剛/.test(t)) return isoFromParts(+today.slice(0, 4), +today.slice(5, 7), +today.slice(8, 10));

  return null;
}

// ── 內文 + 情緒 ──────────────────────────────────────────────────────────────
/** 從 meta 拆出 (dateToken, content) */
function splitMeta(meta: string): { dateToken: string; content: string } {
  // 形如："Jasmine777 追蹤 Lv.20 <日期> 世芯-KY <內文>"
  const afterLv = meta.replace(/^.*?Lv\.\d+\s+/, '');
  const idx = afterLv.indexOf('世芯-KY');
  if (idx >= 0) {
    return { dateToken: afterLv.slice(0, idx).trim(), content: afterLv.slice(idx + '世芯-KY'.length).replace(/閱讀更多/g, ' ').trim() };
  }
  return { dateToken: afterLv.slice(0, 24).trim(), content: afterLv.replace(/閱讀更多/g, ' ').trim() };
}

function deriveTitle(content: string): string {
  const seg = content.split(/[！!？?。\n]/).map((s) => s.trim()).filter(Boolean);
  // 跳過純問候（各位…好）取第一句有料的
  const skip = /^(各位|大家|親愛|早安|午安|晚安|安安)/;
  const head = seg.find((s) => s.length >= 6 && !skip.test(s)) ?? seg[0] ?? content.slice(0, 30);
  return head.slice(0, 40);
}

// 看多/看空關鍵字（依她的用語校準；她常把利空講成利多，故偏多權重略保守）
const BULL = ['利多', '好消息', '春天', '恭喜', '月增', '年增', '成長', '突破', '噴', '起漲', '抄底', '低檔', '買進', '加碼', '價值投資', '長期', '長線', '看好', '信心', '需求', '殷切', '瘋狂詢問', '大客戶', '訂單', '創高', '新高', '護盤', '主力', '反彈', '落底', '打底', '便宜', '低估', '抱', '續抱', '王者', '龍頭', '飆', '軋空', '回升', '錢進', '進場'];
const BEAR = ['套牢', '套', '崩', '重挫', '跌破', '測底', '賣壓', '出貨', '危險', '不好做', '減少進出', '買綠不買紅', '大跌才進場', '觀望', '衰退', '利空', '小心', '修正', '走弱', '綠油油', '下殺', '疲弱', '破底', '停損', '風險', '恐慌', '賣', '減碼', '逃命'];

function classify(content: string): { sentiment: 'bullish' | 'bearish' | 'neutral'; score: number } {
  let s = 0;
  for (const k of BULL) if (content.includes(k)) s += 1;
  for (const k of BEAR) if (content.includes(k)) s -= 1;
  // ❤️ 為她樂觀情緒的弱訊號（多顆才算）
  const hearts = (content.match(/❤/g) || []).length;
  if (hearts >= 3) s += 1;
  const sentiment = s >= 1 ? 'bullish' : s <= -1 ? 'bearish' : 'neutral';
  return { sentiment, score: s };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error('用法：npx tsx scripts/parse-cmoney-dump.ts --in <dump.json> --out <labels.json> [--today YYYY-MM-DD]');
    process.exit(1);
    return;
  }
  const today = args.today ?? todayTaipei();
  const raw: RawEntry[] = JSON.parse(await fs.readFile(path.resolve(args.in), 'utf-8'));

  const articles: any[] = [];
  let dropped = 0;
  const unparsedDates: string[] = [];
  for (const r of raw) {
    if (!r.id || !r.meta) {
      dropped++;
      continue;
    }
    const { dateToken, content } = splitMeta(r.meta);
    const postedAt = parseDateToken(dateToken, today);
    if (!postedAt) {
      unparsedDates.push(dateToken.slice(0, 20));
      dropped++;
      continue;
    }
    const cls = classify(content);
    articles.push({
      id: r.id,
      postedAt,
      url: `https://www.cmoney.tw/forum/article/${r.id}`,
      title: deriveTitle(content),
      sentiment: cls.sentiment,
      sentiment_auto: true, // 由內文預覽啟發式推估，請人工抽查/覆蓋
      sentiment_score: cls.score,
      preview: content.slice(0, 140),
    });
  }
  // 依日期新→舊
  articles.sort((a, b) => b.postedAt.localeCompare(a.postedAt));

  const out = {
    _note: [
      '由 scripts/parse-cmoney-dump.ts 從瀏覽器 DOM dump 轉出。',
      'sentiment 為「內文預覽」關鍵字啟發式(sentiment_auto=true)，預覽僅~140字且她常把利空講成利多 → 請抽查並覆蓋為人工判定。',
      '直接 --input 跑分析：npx tsx scripts/jasmine777-correlation.ts --input ' + args.out,
    ],
    articles,
  };
  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await fs.writeFile(path.resolve(args.out), JSON.stringify(out, null, 2), 'utf-8');

  const dist = articles.reduce((m: Record<string, number>, a) => ((m[a.sentiment] = (m[a.sentiment] || 0) + 1), m), {});
  console.log(`解析 ${articles.length} 篇（drop ${dropped}），日期 ${articles.at(-1)?.postedAt.slice(0, 10)} ~ ${articles[0]?.postedAt.slice(0, 10)}`);
  console.log('情緒分布（自動推估）：', dist);
  if (unparsedDates.length) console.log('未能解析的日期 token：', unparsedDates);
  console.log(`已輸出：${args.out}`);
}

main().catch((e) => {
  console.error('[失敗]', e instanceof Error ? e.message : e);
  process.exit(1);
});
