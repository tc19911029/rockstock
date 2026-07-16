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
import { adjacentNameCode, buildScreenMaster, codeContextConfident } from '@/lib/youtube/keyframeScreen';
import { findPhoneticHits, chineseCore, estimateCueTime } from '@/lib/youtube/phoneticMatch';

const date = process.argv[2];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('用法: npx tsx scripts/audit-keyframe-coverage.ts YYYY-MM-DD');
  process.exit(2);
}

interface Frame { ts: number; file: string | null; ocr_text: string; hit_codes: string[] }
interface KfRecord { video_id: string; source_id: string; status: string; frames: Frame[] }

/**
 * 用簡報上的價格反推「這個 OCR 代號是不是看錯了」。
 *
 * 2026-07-15：K 線圖標題「台勝科（3532）」被 OCR 讀成「台版利（3332）」— 連股名都糊了，
 * 所以 codeContextConfident 的股名否決救不到，括號格式照樣判強訊號 → FAIL → 依規則
 * skill「必須補 mention」→ 等於強迫把幸康(3332) 這檔錯的股票寫進資料。
 * 但簡報同時印著「2026/07/13 開465.50」，而 3332 根本沒有這個行情、3532 開盤正好 465.5。
 * → 拿代號去對 L1 當日 K 棒，價格對不上就是鐵證。
 *
 * 回傳 misread 理由；null = 沒有反證（維持原判定）。
 * 刻意保守：只在「拿得到明確反證」時降級，拿不到資料一律不降（寧可 FAIL 讓人看一眼）。
 */
/**
 * 券商分點表偵測。
 *
 * 2026-07-15：籌碼類節目的「券商分點買超排行」表印的是**券商代號**，格式跟股票一模一樣：
 *   元大證券（9800）／統一（5850）／美林（1440）／野村（1560）／花旗環球（1590）
 * 而 1440=南紡、1590=亞德客-KY、5850=茂矽 — 券商代號與股票代號撞號。
 * 舊版看到「（1440）」就判強訊號 FAIL → 要求把南紡補進「今日提及股票」= 純造假。
 * 這種表天天有，是系統性假警報，故整幀排除（只降 WARN、不是丟棄資料）。
 */
function looksLikeBrokerTable(text: string): boolean {
  return /券商/.test(text) && /(分點|隔日沖|買超成本|券商名稱|券商屬性)/.test(text);
}

async function priceContradiction(code: string, ocrText: string, date: string): Promise<string | null> {
  if (looksLikeBrokerTable(ocrText)) {
    return `此幀為券商分點表，（${code}）是券商代號不是股票代號`;
  }

  let bar: { open: number; high: number; low: number; close: number } | undefined;
  let hasL1 = true;
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'data', 'candles', 'TW', `${code}.TW.json`), 'utf-8'),
    );
    const arr = Array.isArray(raw) ? raw : (raw.candles ?? raw.data ?? []);
    bar = arr.find((c: { date: string }) => String(c.date).slice(0, 10) === date);
  } catch {
    hasL1 = false;
  }

  // 反證 1：連 L1 檔都沒有 → 這代號不是能被畫日線圖的上市櫃標的（3332/6188 實例）
  if (!hasL1) return `${code} 無 L1 日K（畫得出日線圖的代號不可能沒有行情）`;
  if (!bar) return null;   // 有檔案但當日無 bar（停牌等）→ 證據不足，不降級

  // 反證 2：K 線圖標題價格對不上該代號當日 OHLC。
  // ⚠️ 必須嚴格，否則會誤殺真的漏抽：
  //   a) 只看代號附近 ±80 字（密集表格一幀有幾十檔，全幀撈數字會拿到別檔的價格）
  //   b) 該幀要真的像 K 線圖（SMA / 日K / 日線），排除法人表、跑馬燈
  //   c) 只認「像價格」的數字（有小數點或 ≥3 位數），排除「2」「1」這種 OCR 雜訊
  //   d) 至少 2 個，單一數字巧合對不上不算證據
  if (!/SMA|日\s?K|日\s?線|EK/i.test(ocrText)) return null;
  const idx = ocrText.indexOf(code);
  if (idx < 0) return null;
  const win = ocrText.slice(Math.max(0, idx - 80), Math.min(ocrText.length, idx + code.length + 80));
  const year = Number(date.slice(0, 4));
  const nums = [...win.matchAll(/([0-9]+\.[0-9]+|[0-9]{3,})/g)]
    .map(m => parseFloat(m[1]))
    .filter(n => Number.isFinite(n) && n >= 1 && n <= 100000)
    // 代號自己、年份、日期數字不是價格（否則證據列印出來像鬼扯，也可能巧合命中 OHLC）
    .filter(n => String(n) !== code && n !== year);
  if (nums.length < 2) return null;

  // 任一數字對得上當日 OHLC（±0.5% 容忍 OCR 誤差）→ 沒有反證
  const ohlc = [bar.open, bar.high, bar.low, bar.close];
  if (nums.some(n => ohlc.some(v => Math.abs(n - v) <= Math.max(0.01, v * 0.005)))) return null;

  return `${code} 當日 K 棒 O${bar.open}/H${bar.high}/L${bar.low}/C${bar.close} 對不上圖上價格 ${nums.slice(0, 4).join('/')}`;
}

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
      const misread = strongFrame ? await priceContradiction(code, strongFrame.ocr_text, date) : null;
      if (strongFrame && !misread) {
        strongMisses += 1;
        console.log(`FAIL [${rec.video_id}] 代號 ${code}（${frames.length} 幀，含股名/括號佐證）不在 analysis`);
        console.log(`     ts=${Math.round(best.ts)}s 截圖=${best.file ?? '(無存圖)'}`);
        console.log(`     OCR:「${snippet}」`);
      } else if (misread) {
        warns += 1;
        console.log(
          `WARN [${rec.video_id}] 代號 ${code} 有反證、不要求補 — ${misread}` +
          ` ts=${Math.round(best.ts)}s「${snippet}」`,
        );
      } else {
        warns += 1;
        // 相鄰股名指向別的代號 → 多半是 OCR 把數字看錯（股名比數字可靠）。
        // 講清楚「可能是誰」，免得下次又有人照 FAIL 硬補錯代號。
        const alt = adjacentNameCode(best.ocr_text, code, sm);
        if (alt) {
          console.log(
            `WARN [${rec.video_id}] 代號 ${code} 疑似 OCR 看錯數字 — 相鄰股名「${alt.name}」其實是 ${alt.code}` +
            `${mentionCodes.has(alt.code) ? `（${alt.code} 已在 analysis，無需補）` : `（${alt.code} 不在 analysis，請確認）`}` +
            ` ts=${Math.round(best.ts)}s「${snippet}」`,
          );
        } else {
          console.log(`WARN [${rec.video_id}] 代號 ${code} 無股名佐證（可能是盤面數字）ts=${Math.round(best.ts)}s「${snippet}」`);
        }
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

  // slide-only mention 但逐字稿有拼音同音嫌疑 → 疑似 Whisper 誤植害語音端漏判
  // （2026-07-02 台聚→「台劇」教訓：整段看多被降成 slide-only 只介紹）
  const transcriptCache = new Map<string, { text: string; cues: Array<{ start: number; text: string }> } | null>();
  async function loadTranscript(videoId: string) {
    if (transcriptCache.has(videoId)) return transcriptCache.get(videoId)!;
    let rec: { text: string; cues: Array<{ start: number; text: string }> } | null = null;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'transcripts', date, `${videoId}.json`), 'utf-8'));
      const cues: Array<{ start: number; text: string }> = raw.cues ?? [];
      rec = { text: cues.length > 0 ? cues.map(c => c.text).join(' ') : (raw.text ?? ''), cues };
    } catch { /* 無逐字稿 → 跳過 */ }
    transcriptCache.set(videoId, rec);
    return rec;
  }
  for (const m of mentions) {
    if (m.source_type !== 'slide' || !m.matched?.code || !m.video_id) continue;
    const t = await loadTranscript(m.video_id);
    if (!t || !t.text) continue;
    const core = chineseCore(m.matched.name ?? '');
    if (core.length < 2 || t.text.includes(core)) continue; // 字面有出現 → skill 已可自行合併
    const hits = findPhoneticHits(m.matched.name ?? '', t.text, { maxForms: 1 });
    if (hits.length === 0) continue;
    warns += 1;
    const at = estimateCueTime(t.cues, hits[0].first_index);
    console.log(
      `WARN mention ${m.matched.code} ${m.matched.name}（slide-only）逐字稿有同音嫌疑` +
      `「${hits[0].form}」×${hits[0].count} @${at ?? '?'}s — 必須讀該段判斷是否升 speech+slide：` +
      `「${hits[0].context}」`,
    );
  }

  console.log(`\n[keyframe-coverage] ${date}: 強訊號漏抽 ${strongMisses}、警告 ${warns}`);
  if (strongMisses > 0) {
    console.log('→ 必須回去補：每個 FAIL 代號加一筆 mention（source_type="slide"、screenshot_ref=上列截圖路徑、');
    console.log('  sentiment/reason 用該幀附近逐字稿判斷；判斷不出方向 → mentioned_only/只介紹）。補完重跑本稽核。');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
