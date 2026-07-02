/**
 * audit-keyframe-coverage — 驗證 analysis 沒漏掉「簡報上有、嘴巴沒唸」的股票
 *
 * 用法：npx tsx scripts/audit-keyframe-coverage.ts 2026-06-11
 *
 * 規則（/youtube-analysis skill Step 9.4 強制跑）：
 *   - 對每支有 keyframe record 的影片，收集 OCR hit_codes
 *   - 「強訊號」= 代號上下文高信心（codeContextConfident：±10 字內有該代號的
 *     股名/alias，或（代號）括號格式如「（5522）遠雄日線圖」）— 刻意製作的簡報
 *   - 強訊號代號不在 analysis mentions → FAIL（exit 1），skill 必須補 mention
 *     （source_type='slide'、screenshot_ref、sentiment 從 transcript_window 判斷）
 *   - 裸代號（無股名佐證，可能是盤面數字/跑馬燈 OCR 殘渣）→ 只列 WARN 不擋
 *   - 另檢查：source_type ∈ {slide, speech+slide} 的 mention 若 screenshot_ref 缺 → WARN
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadStockMaster } from '@/lib/youtube/stockMaster';
import { buildScreenMaster, codeContextConfident } from '@/lib/youtube/keyframeScreen';

const date = process.argv[2];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('用法: npx tsx scripts/audit-keyframe-coverage.ts YYYY-MM-DD');
  process.exit(2);
}

interface Frame { ts: number; file: string | null; ocr_text: string; hit_codes: string[] }
interface KfRecord { video_id: string; source_id: string; status: string; frames: Frame[] }

async function main() {
  const ROOT = path.join(process.cwd(), 'data', 'youtube');
  const analysis = JSON.parse(await fs.readFile(path.join(ROOT, 'analysis', `${date}.json`), 'utf-8'));
  const mentions = [...(analysis.high_consensus_stocks ?? []), ...(analysis.weak_signal_stocks ?? [])];
  const mentionCodes = new Set(mentions.map((m: { matched?: { code?: string } }) => m.matched?.code).filter(Boolean));

  // 該日全部 keyframe records
  const kfDir = path.join(ROOT, 'keyframes', date);
  let recordFiles: string[] = [];
  try {
    recordFiles = (await fs.readdir(kfDir)).filter(f => f.endsWith('.json'));
  } catch {
    console.log(`[keyframe-coverage] ${date} 無 keyframe records — 跳過（PASS）`);
    return;
  }

  const sm = buildScreenMaster(await loadStockMaster());

  let strongMisses = 0;
  let warns = 0;

  for (const f of recordFiles) {
    const rec: KfRecord = JSON.parse(await fs.readFile(path.join(kfDir, f), 'utf-8'));
    if (rec.status !== 'ok' || rec.frames.length === 0) continue;

    // code → 出現的幀列表
    const codeFrames = new Map<string, Frame[]>();
    for (const fr of rec.frames) {
      for (const c of fr.hit_codes) {
        const arr = codeFrames.get(c) ?? [];
        arr.push(fr);
        codeFrames.set(c, arr);
      }
    }

    for (const [code, frames] of codeFrames) {
      if (mentionCodes.has(code)) continue;
      // 強訊號 = 任一幀內代號上下文高信心（股名相鄰 / 括號格式）
      const strongFrame = frames.find(fr => codeContextConfident(fr.ocr_text, code, sm));
      const best = strongFrame ?? [...frames].sort((a, b) => b.hit_codes.length - a.hit_codes.length)[0];
      const snippet = best.ocr_text.replace(/\n/g, ' ').slice(0, 60);
      if (strongFrame) {
        strongMisses += 1;
        console.log(`FAIL [${rec.video_id}] 代號 ${code}（${frames.length} 幀，含股名/括號佐證）不在 analysis`);
        console.log(`     ts=${Math.round(best.ts)}s 截圖=${best.file ?? '(無存圖)'}`);
        console.log(`     OCR:「${snippet}」`);
      } else {
        warns += 1;
        console.log(`WARN [${rec.video_id}] 代號 ${code} 無股名佐證（可能是盤面數字）ts=${Math.round(best.ts)}s「${snippet}」`);
      }
    }
  }

  // slide 類 mention 缺 screenshot_ref 檢查
  for (const m of mentions) {
    if ((m.source_type === 'slide' || m.source_type === 'speech+slide') && !m.screenshot_ref) {
      warns += 1;
      console.log(`WARN mention ${m.matched?.code ?? m.raw_query}（${m.source_type}）缺 screenshot_ref`);
    }
  }

  console.log(`\n[keyframe-coverage] ${date}: 強訊號漏抽 ${strongMisses}、警告 ${warns}`);
  if (strongMisses > 0) {
    console.log('→ 必須回去補：每個 FAIL 代號加一筆 mention（source_type="slide"、screenshot_ref=上列截圖路徑、');
    console.log('  sentiment/reason 用該幀附近逐字稿判斷；判斷不出方向 → mentioned_only/只介紹）。補完重跑本稽核。');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
