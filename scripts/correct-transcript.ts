#!/usr/bin/env npx tsx
/**
 * correct-transcript.ts
 *
 * 讀 Whisper segments.json，做：
 *   1) 同音錯字校正（財經常見錯誤 + 可擴充字典）
 *   2) 用 rockstock 的 lookupStock 抽出討論到的個股
 *   3) 合併短 segment 成大段落（方便閱讀）
 *   4) 寫 JSON + Markdown
 *
 * 用法：
 *   npx tsx scripts/correct-transcript.ts \
 *     --in /tmp/yt-XXX/segments.json \
 *     --video-id XXX --title "..." --uploader "..." \
 *     --upload-date 2026-05-24 --duration 4361 --url "..." \
 *     --out-json data/youtube/transcripts/manual/2026-05-24/XXX.json \
 *     --out-md   data/youtube/transcripts/manual/2026-05-24/XXX.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadStockMaster, lookupStock, type StockMasterFile } from '../lib/youtube/stockMaster';

// ── 同音錯字字典（key 為 Whisper 常寫錯的字 → value 為正確字）
// 加新項時請在 commit message 留下發現的影片 video_id
const HOMOPHONE_FIXES: Array<[RegExp, string]> = [
  // ── 股票名（最高優先序，因為錯字會影響 lookupStock）
  [/2337\s*萬宏/g, '2337 旺宏'],
  [/2337\s*望紅/g, '2337 旺宏'],
  [/萬宏目標價/g, '旺宏目標價'],
  [/(?<!\w)望紅(?!\w)/g, '旺宏'],
  [/(?<!\w)萬宏(?!\w)/g, '旺宏'],
  [/聯發課/g, '聯發科'],
  [/光盛/g, '光聖'],   // 3164 光聖 (光通訊股)
  [/光通(?!訊)/g, '光通訊'],   // 「光通」單獨出現都是「光通訊」族群簡稱

  // ── 族群名稱（雷老闆 KipYyx89xyM 提到的 3 黑馬）
  [/矽金元/g, '矽晶圓'],
  [/細菌元/g, '矽晶圓'],
  [/細菁原/g, '矽晶圓'],
  [/細晶圓/g, '矽晶圓'],

  // ── 籌碼/操作術語
  [/疊停/g, '跌停'],
  [/兌停/g, '跌停'],
  [/銀頭(小利)?/g, '蠅頭$1'],
  [/上司櫃/g, '上市櫃'],
  [/法輪業務/g, '法人業務'],
  [/做法輪/g, '做法人'],
  [/砝人/g, '法人'],
  [/投訊/g, '投信'],
  [/法縮會/g, '法說會'],
  [/可轉載/g, '可轉債'],
  [/負力(的威力|威力)?/g, '複利$1'],
  [/富力(的威力|威力)?/g, '複利$1'],
  [/業績腰骨/g, '業績妖股'],
  [/題材的腰骨/g, '題材的妖股'],
  [/提財的邀股/g, '題材的妖股'],
  [/提財/g, '題材'],
  [/邀股/g, '妖股'],
  [/腰膽/g, '腰斬'],
  [/標股族群/g, '妖股族群'],
  [/DTS要上秀/g, 'EPS要上修'],
  [/隔一層沙/g, '隔一層紗'],
  [/儲置股/g, '儲值股'],
  [/進儲置/g, '進入處置'],
  [/進出制/g, '進入處置'],
  [/出制(?!度|品|口|境)/g, '處置'],
  [/被處置/g, '被處置'],
  [/月限季限/g, '月線季線'],
  [/月限/g, '月線'],
  [/季限/g, '季線'],
  [/偵測領界點/g, '偵測臨界點'],
  [/高低位接/g, '高低位階'],
  [/位接(?!收|觸)/g, '位階'],
  [/全部都出關/g, '全部都解禁'],
  [/出關之後/g, '解禁之後'],
  [/爆破斷/g, '跑波段'],
  [/爆波段/g, '跑波段'],
  [/微快不破/g, '唯快不破'],

  // ── 散戶 / 興櫃
  [/(?<!主|消|觀|品)賞務/g, '散戶'],
  [/閃戶/g, '散戶'],
  [/新貴股/g, '興櫃股'],
  [/碰新貴/g, '碰興櫃'],
  [/做新貴/g, '做興櫃'],
  [/在新貴/g, '在興櫃'],
  [/新貴生技股/g, '興櫃生技股'],
  [/直接新貴/g, '直接興櫃'],
  [/興貴/g, '興櫃'],

  // ── 工具/業務口語
  [/投雇/g, '投顧'],
  [/投雇起家/g, '投顧起家'],
  [/跑公司/g, '拜訪公司'],
  [/法業之前/g, '入行業之前'],
  [/碰碼/g, '砍碼'],
  [/控盤/g, '控盤'],

  // ── 漲跌相關
  [/股票一直關/g, '股票一直漲'],
  [/越關越大圍/g, '越漲越大尾'],
  [/越漲越大圍/g, '越漲越大尾'],
  [/一路關/g, '一路漲'],

  // ── 人物名
  [/周興詞/g, '周星馳'],
  [/火雲先生/g, '火雲邪神'],
  [/李嘉誠/g, '李嘉誠'],
  [/陳薇良/g, '陳威良'],
  [/魏良哥/g, '威良哥'],
  [/未良哥/g, '威良哥'],
  [/慶祥/g, '慶翔'],   // 主持人趙慶翔

  // ── 成語
  [/無娘公儉讓/g, '溫良恭儉讓'],
  [/不溫良/g, '不溫良'],

  // ── 政治經濟
  [/川席會/g, '川習會'],

  // ── 樂觀
  [/超限時/g, '超興奮'],
  [/老闆升降/g, '老闆身價'],

  // ── 數字
  [/(\d+)\s*趴/g, '$1%'],
];

interface Segment {
  start: number;
  end: number;
  text: string;
}

interface InputJson {
  model?: string;
  language?: string;
  duration?: number;
  segments: Segment[];
  full_text?: string;
}

interface StockMention {
  code: string;
  name: string;
  market: 'TWSE' | 'TPEx';
  confidence: number;
  match_via: string;
  mention_count: number;
  first_seen_at: number;     // seconds
  contexts: string[];        // 前 3 段 context（≤ 80 字）
}

// ── CLI args
function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      out[args[i].slice(2)] = args[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

function applyHomophoneFixes(text: string): { fixed: string; replacements: number } {
  let fixed = text;
  let count = 0;
  for (const [pattern, repl] of HOMOPHONE_FIXES) {
    const before = fixed;
    fixed = fixed.replace(pattern, repl);
    if (fixed !== before) count++;
  }
  return { fixed, replacements: count };
}

/**
 * 把連續短 segment 合併成段落（方便閱讀）。
 * 合併策略：相鄰 segment 間距 < 3s 就合併，但段落 ≤ 200 字。
 */
function mergeIntoParagraphs(segments: Segment[]): Segment[] {
  const paras: Segment[] = [];
  let cur: Segment | null = null;
  for (const seg of segments) {
    if (!cur) {
      cur = { ...seg };
      continue;
    }
    const gap = seg.start - cur.end;
    const wouldLen = cur.text.length + seg.text.length;
    if (gap < 3.0 && wouldLen < 200) {
      cur.end = seg.end;
      cur.text += seg.text;
    } else {
      paras.push(cur);
      cur = { ...seg };
    }
  }
  if (cur) paras.push(cur);
  return paras;
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 年份範圍：1990-2030 都是 4 位數，極易誤抽（"2024 年" 撞 2024 志聯）。
// 排除策略：4 位數字在 1980-2050 區間 → 必須緊鄰確切的股名或「股」「檔」字才採用
function isLikelyYear(code: string, surroundingText: string, position: number): boolean {
  const n = Number(code);
  if (n < 1980 || n > 2050) return false;
  // 看前後 3 字是否有「年」「歲」等年份標記
  const before = surroundingText.slice(Math.max(0, position - 3), position);
  const after = surroundingText.slice(position + code.length, position + code.length + 3);
  if (/年|歲|月份|月底|月底前|年底|年中/.test(after)) return true;
  if (/到|去|至|是|當|去年|今年|明年|未來/.test(before)) return true;
  return false;
}

function extractStocks(paras: Segment[], master: StockMasterFile): StockMention[] {
  const candidates = new Map<string, StockMention>();

  // 短名（2 字或以下）誤抽嚴重的個股 — 一般用詞會撞名
  // 只在「ALIAS_MAP 明確列出的常見簡稱」or「context 有股價/買賣訊號」時才接受
  const SHORT_NAME_BLACKLIST = new Set([
    '數字', '世界', '大量', '精華', '新產', '中鋼', '南亞', '美亞', '燁輝', '志聯',
    '彰源', '高興昌', '大成鋼', '聯發', // 「聯發」短於「聯發科」，撞到
    '華通',
  ]);

  for (const para of paras) {
    const text = para.text;

    // 1) 4 位數字（股票代號）— 排除年份
    const codeMatches = Array.from(text.matchAll(/\d{4,6}/g));
    for (const m of codeMatches) {
      const code = m[0];
      const pos = m.index ?? 0;
      if (code.length === 4 && isLikelyYear(code, text, pos)) continue;
      const hit = lookupStock(code, master);
      if (!hit || hit.confidence < 0.9) continue;
      // 黑名單股名也要再過濾（避免 4 位數本身對到雜訊股）
      if (SHORT_NAME_BLACKLIST.has(hit.name) && !/股|檔|目標價|首選|買|賣/.test(text)) continue;
      addMention(candidates, hit, para, text);
    }

    // 2) 股票名 / alias 完整出現（嚴格 substring）
    //    只走 ALIAS_MAP 範圍 + master.entries 中名稱 ≥ 3 字 的，2 字名容易誤抽
    for (const entry of master.entries) {
      const candidates_names: string[] = [];
      if (entry.name.length >= 3) candidates_names.push(entry.name);
      for (const alias of entry.aliases) {
        if (alias.length >= 2) candidates_names.push(alias);   // ALIAS_MAP 的別名是經人工審過的，2 字也可信
      }
      for (const name of candidates_names) {
        if (!text.includes(name)) continue;
        // 短名仍需過 blacklist
        if (name.length <= 2 && SHORT_NAME_BLACKLIST.has(name)) continue;
        const hit = lookupStock(name, master);
        if (!hit || hit.confidence < 0.85) continue;
        addMention(candidates, hit, para, text);
      }
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => b.mention_count - a.mention_count);
}

function addMention(
  map: Map<string, StockMention>,
  hit: ReturnType<typeof lookupStock>,
  para: Segment,
  text: string,
): void {
  if (!hit) return;
  const key = hit.code;
  const existing = map.get(key);
  const ctx = text.length > 80 ? text.slice(0, 80) + '…' : text;
  if (existing) {
    existing.mention_count++;
    if (existing.contexts.length < 3) existing.contexts.push(ctx);
    if (hit.confidence > existing.confidence) {
      existing.confidence = hit.confidence;
      existing.match_via = hit.match_via;
    }
  } else {
    map.set(key, {
      code: hit.code,
      name: hit.name,
      market: hit.market,
      confidence: hit.confidence,
      match_via: hit.match_via,
      mention_count: 1,
      first_seen_at: para.start,
      contexts: [ctx],
    });
  }
}

function buildMarkdown(meta: {
  video_id: string;
  title: string;
  uploader: string;
  upload_date: string;
  duration: number;
  url: string;
}, paras: Segment[], stocks: StockMention[], totalReplacements: number, model: string): string {
  const lines: string[] = [];
  lines.push(`# ${meta.title}`);
  lines.push('');
  lines.push(`- **頻道**: ${meta.uploader}`);
  lines.push(`- **上架日期**: ${meta.upload_date}`);
  lines.push(`- **影片長度**: ${Math.floor(meta.duration / 60)} 分 ${meta.duration % 60} 秒`);
  lines.push(`- **YouTube**: ${meta.url}`);
  lines.push(`- **video_id**: \`${meta.video_id}\``);
  lines.push(`- **轉錄**: mlx-whisper / ${model}`);
  lines.push(`- **校正**: ${totalReplacements} 處同音錯字`);
  lines.push('');

  if (stocks.length > 0) {
    lines.push('## 提到的個股（依出現次數排序）');
    lines.push('');
    lines.push('| 代號 | 名稱 | 市場 | 提到次數 | 首次出現 | 信心 |');
    lines.push('|---|---|---|---|---|---|');
    for (const s of stocks) {
      lines.push(
        `| ${s.code} | ${s.name} | ${s.market} | ${s.mention_count} | ${formatTimestamp(s.first_seen_at)} | ${s.confidence.toFixed(2)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## 完整逐字稿（校正後 + 時間戳）');
  lines.push('');
  for (const para of paras) {
    const ts = formatTimestamp(para.start);
    lines.push(`**[${ts}]** ${para.text.trim()}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const required = ['in', 'video-id', 'title', 'out-json', 'out-md'];
  for (const r of required) {
    if (!args[r]) {
      console.error(`缺少參數 --${r}`);
      process.exit(1);
    }
  }

  const input: InputJson = JSON.parse(fs.readFileSync(args.in, 'utf-8'));
  console.log(`讀入 ${input.segments.length} segments (model=${input.model || '?'}, duration=${input.duration || 0}s)`);

  // 1) 校正每段
  let totalReplacements = 0;
  const correctedSegments: Segment[] = input.segments.map((seg) => {
    const { fixed, replacements } = applyHomophoneFixes(seg.text);
    totalReplacements += replacements;
    return { ...seg, text: fixed };
  });
  console.log(`校正 ${totalReplacements} 處同音錯字`);

  // 2) 合併成段落
  const paragraphs = mergeIntoParagraphs(correctedSegments);
  console.log(`合併成 ${paragraphs.length} 個段落`);

  // 3) 抽股票
  const master = await loadStockMaster();
  console.log(`stock-master 載入 ${master.entries.length} 檔`);
  const stocks = extractStocks(paragraphs, master);
  console.log(`抽出 ${stocks.length} 檔個股`);

  // 4) 寫 JSON
  const meta = {
    video_id: args['video-id'],
    title: args.title,
    uploader: args.uploader || '',
    upload_date: args['upload-date'] || new Date().toISOString().slice(0, 10),
    duration: Number(args.duration || 0),
    url: args.url || `https://youtu.be/${args['video-id']}`,
  };

  const outJson = {
    metadata: meta,
    model: input.model || 'unknown',
    transcribed_at: new Date().toISOString(),
    corrections_applied: totalReplacements,
    segments: correctedSegments,
    paragraphs: paragraphs,
    stocks,
  };

  fs.mkdirSync(path.dirname(args['out-json']), { recursive: true });
  fs.writeFileSync(args['out-json'], JSON.stringify(outJson, null, 2), 'utf-8');
  console.log(`寫入 ${args['out-json']}`);

  // 5) 寫 Markdown
  const md = buildMarkdown(meta, paragraphs, stocks, totalReplacements, input.model || 'unknown');
  fs.mkdirSync(path.dirname(args['out-md']), { recursive: true });
  fs.writeFileSync(args['out-md'], md, 'utf-8');
  console.log(`寫入 ${args['out-md']}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
