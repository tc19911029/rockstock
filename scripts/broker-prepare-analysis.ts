/**
 * 法人報告分析 prepare — 掃 PDF 資料夾 → 寫 question payload 到 /tmp（給 /broker-analysis skill 讀）。
 *
 * 對齊 YouTube 的 file-bridge：程式只負責整理乾淨，分析由對話中的 Claude 做。
 *
 * 用法：
 *   npx tsx scripts/broker-prepare-analysis.ts [--dir ~/Downloads/broker-reports] [--date 2026-06-07]
 *
 * 檔名格式：{msgid}_{YYMMDD}_{broker}_{stock-or-topic}.pdf
 *   例 617561986145714266_260607_ms_kingslide.pdf → broker=ms, date=2026-06-07
 * 不符格式者：仍嘗試從檔名抓 6 位日期 + registry alias 比對 broker。
 *
 * 乾淨 PDF → pypdf 抽文字；CID 亂碼 → pymupdf render PNG（broker_extract.py 處理）。
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadStockMaster } from '@/lib/youtube/stockMaster';
import { DEFAULT_BROKERS } from '@/lib/broker/brokerStorage';

const TMP_ROOT = path.join(os.tmpdir(), 'rockstock-broker');
const PY = 'python3';
const EXTRACT = path.join(process.cwd(), 'scripts', 'broker_extract.py');

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function parseFilename(fname: string): { report_id: string; date: string | null; broker: string | null; topic: string } {
  const base = fname.replace(/\.pdf$/i, '');
  const m = base.match(/^(\d{6,})_(\d{6})_([a-zA-Z]+)_(.+)$/);
  if (m) {
    const [, msgid, yymmdd, brokerTok, topic] = m;
    const date = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
    return { report_id: msgid, date, broker: matchBroker(brokerTok), topic };
  }
  // fallback：抓任意 6 位日期 + alias 比對
  const dm = base.match(/(\d{6})/);
  const date = dm ? `20${dm[1].slice(0, 2)}-${dm[1].slice(2, 4)}-${dm[1].slice(4, 6)}` : null;
  const idm = base.match(/^(\d{6,})/);
  const report_id = idm ? idm[1] : base.slice(0, 24);
  return { report_id, date, broker: matchBrokerFromText(base), topic: base };
}

function matchBroker(tok: string): string | null {
  const t = tok.toLowerCase();
  for (const b of DEFAULT_BROKERS) {
    if (b.key === t || b.aliases.includes(t)) return b.key;
  }
  return t || null;
}
function matchBrokerFromText(text: string): string | null {
  const t = text.toLowerCase();
  for (const b of DEFAULT_BROKERS) {
    if (b.aliases.some(a => t.includes(a))) return b.key;
  }
  return null;
}

async function main() {
  const dir = expandHome(arg('--dir', path.join(os.homedir(), 'Downloads', 'broker-reports'))!);
  const dateFilter = arg('--date');

  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter(f => f.toLowerCase().endsWith('.pdf'));
  } catch {
    console.error(`資料夾不存在：${dir}\n請先 mkdir -p ${dir} 並把券商 PDF 丟進去。`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`${dir} 內沒有 PDF。`);
    process.exit(1);
  }

  const master = await loadStockMaster();
  // hint：只取真實股票（4 位數字代號），排除權證（6 位），降低 payload 體積
  const stockHint = master.entries
    .filter(e => /^\d{4}$/.test(e.code))
    .map(e => ({ code: e.code, name: e.name, market: e.market, aliases: e.aliases?.slice(0, 4) ?? [] }));

  const brokerByKey = new Map(DEFAULT_BROKERS.map(b => [b.key, b]));

  interface Doc {
    report_id: string; source_pdf: string; broker: string | null; broker_display: string | null;
    report_date: string | null; topic: string; parse_mode: string; pages: number; chars: number;
    text?: string; page_images?: string[];
  }
  const byDate = new Map<string, Doc[]>();

  for (const f of files.sort()) {
    const meta = parseFilename(f);
    if (dateFilter && meta.date !== dateFilter) continue;
    const pdfPath = path.join(dir, f);
    const imgDir = path.join(TMP_ROOT, 'pages', meta.report_id);
    const res = spawnSync(PY, [EXTRACT, pdfPath, imgDir], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    let parsed: { mode: string; pages: number; text: string; images: string[]; chars: number };
    try {
      parsed = JSON.parse((res.stdout || '').trim().split('\n').pop() || '{}');
    } catch {
      console.error(`  ⚠ ${f}: 抽取失敗 ${res.stderr?.slice(0, 200)}`);
      continue;
    }
    const bd = meta.broker ? brokerByKey.get(meta.broker) : undefined;
    const doc: Doc = {
      report_id: meta.report_id,
      source_pdf: f,
      broker: meta.broker,
      broker_display: bd?.display ?? meta.broker ?? null,
      report_date: meta.date,
      topic: meta.topic,
      parse_mode: parsed.mode === 'vision' ? 'vision' : 'text',
      pages: parsed.pages,
      chars: parsed.chars,
      ...(parsed.mode === 'vision' ? { page_images: parsed.images } : { text: parsed.text }),
    };
    const key = meta.date ?? 'unknown';
    const arr = byDate.get(key) ?? [];
    arr.push(doc);
    byDate.set(key, arr);
    console.log(`  ✓ ${f} → ${doc.parse_mode}（${parsed.pages}p, ${parsed.chars} chars）broker=${doc.broker_display}`);
  }

  await fs.mkdir(TMP_ROOT, { recursive: true });
  for (const [date, docs] of byDate) {
    const out = path.join(TMP_ROOT, `${date}-question.json`);
    const payload = {
      schema_version: 1,
      kind: 'broker-reports',
      date,
      generated_at: new Date().toISOString(),
      output_path: `data/broker/reports/${date}.json`,
      instructions: '逐份讀 documents[]（text 直讀 / vision 用 Read 讀 page_images PNG），萃取 BrokerReport[]，寫到 output_path（schema 見 lib/broker/types.ts BrokerDailyReports）。rating 抄原文到 rating_raw、target/prev_target/currency 從內文、covered 判斷主標的、非台股 matched=null。寫完跑 normalize-broker-reports + audit-broker-reports。',
      documents: docs,
      brokers: DEFAULT_BROKERS,
      stock_master_hint: stockHint,
    };
    await fs.writeFile(out, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`\n寫出 ${out}（${docs.length} 份報告）`);
  }
  console.log(`\n完成。接著在 Claude Code 對話輸入 /broker-analysis 進行分析。`);
}

main().catch(err => { console.error(err); process.exit(1); });
