/**
 * 確定性校正 YouTube 分析的股票代號 + grounding 報告。
 *
 * 用法：
 *   npx tsx scripts/normalize-youtube-analysis.ts <date>          # 校正 + 寫回 + 報告
 *   npx tsx scripts/normalize-youtube-analysis.ts <date> --dry    # 只報告不寫回
 *
 * 流程：載入全量 stock-master → 載入當日全部逐字稿 → normalizeAnalysis → 寫回 + 印報告。
 * 由 /youtube-analysis skill 最後一步呼叫(模型寫完分析後自動校正代號)，也可手動補跑。
 *
 * 代號重查是確定性的，一定會修(模型寫錯也救得回)；grounding 只報告不自動刪
 * (2026-05-30 凱美誤刪教訓：name 查無常是 Whisper 亂碼，不是幻覺)。
 */

import fs from 'fs';
import path from 'path';
import { loadStockMaster } from '@/lib/youtube/stockMaster';
import { normalizeAnalysis } from '@/lib/youtube/normalizeAnalysis';
import type { DailyAnalysis } from '@/lib/youtube/analysisStorage';

const date = process.argv[2];
const dryRun = process.argv.includes('--dry');

if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('用法：npx tsx scripts/normalize-youtube-analysis.ts <YYYY-MM-DD> [--dry]');
  process.exit(1);
}

const ROOT = process.cwd();
const analysisPath = path.join(ROOT, 'data/youtube/analysis', `${date}.json`);
const transcriptDir = path.join(ROOT, 'data/youtube/transcripts', date);

function loadTranscriptsByVideo(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const vid = f.replace(/\.json$/, '');
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // TranscriptRecord.text 優先；退回 cues/segments join；再退回整檔字串
      const text: string = typeof j.text === 'string' && j.text.length
        ? j.text
        : Array.isArray(j.cues)
          ? j.cues.map((c: { text?: string }) => c.text ?? '').join('\n')
          : Array.isArray(j.segments)
            ? j.segments.map((c: { text?: string }) => c.text ?? '').join('\n')
            : fs.readFileSync(path.join(dir, f), 'utf8');
      out[vid] = text;
    } catch {
      // parse 失敗 → 用原始字串(grounding 仍可 includes)
      out[vid] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
  }
  return out;
}

async function main() {
  if (!fs.existsSync(analysisPath)) {
    console.error(`❌ 找不到分析檔：${analysisPath}`);
    process.exit(1);
  }

  const master = await loadStockMaster();
  const analysis: DailyAnalysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
  const transcriptsByVideo = loadTranscriptsByVideo(transcriptDir);
  const transcriptCount = Object.keys(transcriptsByVideo).length;

  const { analysis: fixed, report } = normalizeAnalysis(analysis, master, transcriptsByVideo);

  // ── 報告 ───────────────────────────────────────────────────────────────
  console.log(`\n=== normalize ${date}（master ${master.entries.length} 筆 / 逐字稿 ${transcriptCount} 支）===`);

  console.log(`\n[1] 代號重查：${report.codeFixes.length} 筆變動`);
  for (const f of report.codeFixes) {
    const arrow = f.newCode === null ? `${f.oldCode} → matched=null（master 查無）` : `${f.oldCode ?? '∅'} → ${f.newCode}（${f.via}）`;
    console.log(`   ${f.where} "${f.raw_query}": ${arrow}`);
  }

  console.log(`\n[2] 歸屬可疑（證據在別支影片）：${report.videoMismatches.length} 筆`);
  for (const g of report.videoMismatches) {
    console.log(`   ${g.where} ${g.code} ${g.name}：標的 ${g.claimedVideo} ✗，實際出現於 [${g.foundIn.join(',')}]（命中「${g.matchedForm}」）`);
  }

  console.log(`\n[3] 全逐字稿查無（待人工複查，勿直接刪——可能 Whisper 亂碼）：${report.ungrounded.length} 筆`);
  for (const g of report.ungrounded) {
    console.log(`   ${g.where} ${g.code} ${g.name} @${g.claimedVideo}`);
  }

  if (dryRun) {
    console.log('\n--dry：不寫回。');
    return;
  }

  if (report.codeFixes.length > 0) {
    fs.writeFileSync(analysisPath, JSON.stringify(fixed, null, 2) + '\n');
    console.log(`\n✅ 已寫回 ${analysisPath}（修正 ${report.codeFixes.length} 筆代號）`);
  } else {
    console.log('\n✅ 代號全部正確，無需寫回。');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
