/**
 * 一次性合併腳本：把 split-0715/_out_grp*.json 的 agent 抽取結果
 * 合併成 DailyAnalysis 草稿（不含 stock_scoring，那步由 skill 手動填）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadStockMaster, lookupStock } from '../lib/youtube/stockMaster';
import type { StockMasterFile } from '../lib/youtube/stockMaster';

const SPLIT_DIR = process.argv[2];
const OUT = process.argv[3];

type RawMention = {
  raw_query: string;
  matched_code: string | null;
  matched_name: string | null;
  llm_confidence: number;
  sentiment: string;
  context: string;
  reason: string;
  analysts?: string[];
  recommendation_type?: string;
  source_type?: string;
  mention_time?: number;
  screenshot_ref?: string;
  mentioned_price?: number | null;
  target_price?: number | null;
  stop_loss?: number | null;
};

type RawVideo = {
  video_id: string;
  source_id: string;
  source_name: string;
  title: string;
  url?: string;
  analysts?: string[];
  duration_sec?: number;
  summary: string;
  market_stance?: string;
  key_stocks: Array<{ code: string; name: string }>;
  watch_priority: string;
  watch_reason: string;
  mentions: RawMention[];
};

/**
 * agent 常把 raw_query 寫成帶註解的形式（「松翰（逐字稿作「鬆悍」）」、「納瓦克／南亞科」、
 * 「2303連電（聯電）」）。normalize 會用 raw_query 跑 lookupStock，這種字串一律查無 →
 * 代號被清成 null。這裡先剝註解、拆分隔號，產出可查的候選序列。
 */
function queryCandidates(m: RawMention): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    const t = (s ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  const strip = (s: string) =>
    s.replace(/[（(][^）)]*[）)]/g, '').replace(/[「『][^」』]*[」』]/g, '').trim();

  const raw = m.raw_query ?? '';
  // 前導代號最硬，例：「2059 川湖」「6770立即點」
  const lead = raw.match(/^(\d{4,6})/);
  if (lead) push(lead[1]);
  // 括號內的註解 = agent 的同音更正，優先於走音原話。
  // 例「星雲（辛耘）」：原話「星雲」本身是真實公司 8047，但實指辛耘 3583。
  for (const g of raw.matchAll(/[（(]([^）)]*)[）)]/g)) push(strip(g[1]));
  push(strip(m.matched_name ?? ''));
  push(m.matched_code);
  // 走音原話擺最後：只有前面全查無時才賭它
  for (const part of strip(raw).split(/[／\/、,]/)) push(part.trim());
  push(raw);
  return out;
}

function resolveMatch(m: RawMention, master: StockMasterFile) {
  for (const q of queryCandidates(m)) {
    const hit = lookupStock(q, master);
    if (!hit) continue;
    // 防呆：短 query 模糊命中 ETN/ETF（非 4 位數代號）幾乎都是誤判
    // 例：「領航也是弱弱的（模組廠）」→ 020020 元大台股領航N
    if (hit.match_via === 'fuzzy_substring' && !/^\d{4}$/.test(hit.code)) continue;
    return hit;
  }
  return null;
}

async function main() {
  const master = await loadStockMaster();
  const files = (await fs.readdir(SPLIT_DIR))
    .filter(f => f.startsWith('_out_grp') && f.endsWith('.json'))
    .sort();

  const videos: RawVideo[] = [];
  for (const f of files) {
    const j = JSON.parse(await fs.readFile(path.join(SPLIT_DIR, f), 'utf8'));
    videos.push(...j.videos);
  }

  const allMentions: any[] = [];
  const videoSummaries: any[] = [];

  for (const v of videos) {
    for (const m of v.mentions) {
      const matched = resolveMatch(m, master);
      const llm = Math.max(0, Math.min(1, Number(m.llm_confidence) || 0));
      const combined = matched ? Math.round(llm * matched.confidence * 100) / 100 : 0;
      // raw_query 落地成 master 正規股名：normalize 會拿它重跑 lookupStock，
      // 帶註解的原始字串會被判查無而把代號清成 null（原話仍保存在 context）。
      const out: any = {
        raw_query: matched ? matched.name : m.raw_query,
        matched,
        llm_confidence: llm,
        combined_confidence: combined,
        sentiment: m.sentiment,
        context: m.context,
        reason: m.reason,
        source_id: v.source_id,
        video_id: v.video_id,
        analysts: m.analysts && m.analysts.length ? m.analysts : v.analysts,
      };
      if (m.source_type) out.source_type = m.source_type;
      if (typeof m.mention_time === 'number') out.mention_time = m.mention_time;
      if (m.screenshot_ref) out.screenshot_ref = m.screenshot_ref;
      if (m.recommendation_type) out.recommendation_type = m.recommendation_type;
      if (typeof m.mentioned_price === 'number') out.mentioned_price = m.mentioned_price;
      if (typeof m.target_price === 'number') out.target_price = m.target_price;
      if (typeof m.stop_loss === 'number') out.stop_loss = m.stop_loss;
      allMentions.push(out);
    }

    // key_stocks 也用 master 校正
    const keyStocks: Array<{ code: string; name: string }> = [];
    for (const ks of v.key_stocks || []) {
      const hit = lookupStock(ks.name, master) || lookupStock(ks.code, master);
      if (hit) keyStocks.push({ code: hit.code, name: hit.name });
    }

    videoSummaries.push({
      video_id: v.video_id,
      source_id: v.source_id,
      source_name: v.source_name,
      title: v.title,
      url: v.url,
      analysts: v.analysts,
      summary: v.summary,
      market_stance: v.market_stance,
      key_stocks: keyStocks.slice(0, 5),
      watch_priority: v.watch_priority,
      watch_reason: v.watch_reason,
      duration_sec: v.duration_sec,
    });
  }

  // ── 共識判定 ──
  const byCode = new Map<string, any[]>();
  for (const m of allMentions) {
    if (!m.matched) continue;
    const k = m.matched.code;
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k)!.push(m);
  }

  const highCodes = new Set<string>();
  for (const [code, ms] of byCode) {
    const strong = ms.filter(m => m.combined_confidence >= 0.6);
    const bullSrc = new Set(strong.filter(m => m.sentiment === 'bullish').map(m => m.source_id));
    const bearSrc = new Set(strong.filter(m => m.sentiment === 'bearish').map(m => m.source_id));
    if (bullSrc.size >= 2 && bearSrc.size === 0) highCodes.add(code);
    else if (bearSrc.size >= 2 && bullSrc.size === 0) highCodes.add(code);
  }

  const high: any[] = [];
  const weak: any[] = [];
  for (const m of allMentions) {
    const ok = m.matched && m.combined_confidence >= 0.6 && highCodes.has(m.matched.code);
    (ok ? high : weak).push(m);
  }

  const uniqueCodes = new Set(allMentions.filter(m => m.matched).map(m => m.matched.code));

  const draft = {
    date: '2026-07-15',
    generated_at: new Date().toISOString(),
    market_view: 'TODO',
    bullish_consensus: [],
    bearish_consensus: [],
    high_consensus_stocks: high,
    weak_signal_stocks: weak,
    stock_scoring: [],
    video_summaries: videoSummaries,
    stats: {
      videos_analyzed: videos.length,
      unique_stocks_total: uniqueCodes.size,
      high_consensus_count: high.length,
      weak_signal_count: weak.length,
      rating_distribution: { A: 0, B: 0, C: 0, D: 0 },
    },
  };

  await fs.writeFile(OUT, JSON.stringify(draft, null, 2));

  // ── 報告 ──
  console.log(`videos=${videos.length} mentions=${allMentions.length} unique=${uniqueCodes.size}`);
  console.log(`high=${high.length} weak=${weak.length} highCodes=${highCodes.size}`);
  console.log(`unmatched mentions: ${allMentions.filter(m => !m.matched).length}`);
  console.log('\n=== 高共識股（依提及節目數排序）===');
  const rows = [...highCodes].map(c => {
    const ms = byCode.get(c)!.filter(m => m.combined_confidence >= 0.6);
    const srcs = new Set(ms.map(m => m.source_id));
    const dir = ms.filter(m => m.sentiment === 'bullish').length >= ms.filter(m => m.sentiment === 'bearish').length ? 'bull' : 'bear';
    return { code: c, name: ms[0].matched.name, srcs: srcs.size, n: ms.length, dir };
  }).sort((a, b) => b.srcs - a.srcs || b.n - a.n);
  for (const r of rows) console.log(`${r.code} ${r.name}\t節目=${r.srcs} 提及=${r.n} ${r.dir}`);

  console.log('\n=== 未對到代號的 raw_query ===');
  const un = new Map<string, number>();
  for (const m of allMentions.filter(x => !x.matched)) un.set(m.raw_query, (un.get(m.raw_query) || 0) + 1);
  console.log([...un.entries()].map(([k, v]) => `${k}(${v})`).join(', '));
}

main().catch(e => { console.error(e); process.exit(1); });
