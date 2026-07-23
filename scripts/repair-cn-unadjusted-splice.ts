// ============================================================
// CN「未還權接合」修復：除權息/送轉當天歷史沒被回頭還權 → 留下不可能的 >18% 持續跳階，
// 污染跨該日的 MA/ZB/三色指標。用 Tencent qfq（前復權，全段自洽）重抓覆寫整段。
//
// 偵測：相鄰日 |move|>18%（遠超 ±10/±20% 漲跌停=不可能真實成交）且 +2 日後仍偏 >15%（持續=接合）。
// 修法：tencentHistProvider.getHistoricalCandles(sym,'5y') → saveLocalCandles（同日覆寫=整段還權）。
// 安全：覆寫前一律備份到 data/candles/CN-backup-<ts>/。
//
// 用法：
//   npx tsx scripts/repair-cn-unadjusted-splice.ts            # dry-run，只列出接合股
//   npx tsx scripts/repair-cn-unadjusted-splice.ts --apply
// ============================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tencentHistProvider } from '@/lib/datasource/TencentHistProvider';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { invalidateEntry } from '@/lib/datasource/L1CandleCache';
import type { Candle } from '@/types';

const APPLY = process.argv.includes('--apply');
const VS_QFQ = process.argv.includes('--vs-qfq');
const DAYS = Number(process.argv[process.argv.indexOf('--days') + 1]) || 40;
const DIR = path.join(process.cwd(), 'data/candles/CN');

/** 逐日報酬與 qfq 差 > 這個值即判為接合點。0.8pp 遠大於浮點/四捨五入誤差，又抓得到最小的現金股利。 */
const QFQ_RETURN_GAP = 0.008;

/**
 * qfq 偵測：抓 Tencent 前復權近 DAYS 日，比對「逐日報酬」。
 * 為什麼比報酬不比價位：qfq 全段被乘上還原因子，價位本來就會跟 L1 差一個常數，
 * 只有**報酬**才是兩邊都該相同的量 —— 報酬對不上就代表 L1 在那天把股利當成了跌幅。
 */
async function detectViaQfq(sym: string, cs: Candle[]): Promise<string[]> {
  const from = cs.length > DAYS ? String(cs[cs.length - DAYS].date) : String(cs[0].date);
  const code = sym.slice(0, 6);
  const px = sym.endsWith('.SS') ? 'sh' : 'sz';
  const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=${px}${code},day,${from},2030-01-01,${DAYS + 10},qfq`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json() as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> };
  const rows = j.data?.[px + code]?.qfqday ?? j.data?.[px + code]?.day;
  if (!Array.isArray(rows) || rows.length < 5) throw new Error('qfq rows 不足');
  const q = new Map(rows.map((r) => [r[0], Number(r[2])]));
  const bars = cs.filter((b) => String(b.date) >= from);
  const out: string[] = [];
  for (let i = 1; i < bars.length; i++) {
    const pv = q.get(String(bars[i - 1].date)), cv = q.get(String(bars[i].date));
    if (!pv || !cv || pv <= 0 || bars[i - 1].close <= 0) continue;
    const rL1 = bars[i].close / bars[i - 1].close - 1;
    const rQ = cv / pv - 1;
    if (Math.abs(rL1 - rQ) > QFQ_RETURN_GAP) out.push(String(bars[i].date).replace('*', ''));
  }
  return out;
}

/** 接合偵測：回傳該股的接合日清單（空=乾淨）。
 *  2026-06-12 收緊：門檻改市場別 — 主板漲跌停 ±10% → >11% 即不可能真實成交；
 *  創業板(300/301)/科創(688/689) ±20% → >21%。舊版固定 18% 漏掉 10.5%-18% 的
 *  主板除權跳階（實案：603203 除權日 -16% 三週沒人發現）。
 *  持續性檢查同步調整為「+2 日後仍偏離 > 門檻×0.8」。 */
function spliceThresholdOf(sym: string): number {
  const code = sym.replace(/\.(SS|SZ)$/, '');
  const isGrowth = /^(30[01]|68[89])/.test(code);
  return isGrowth ? 0.21 : 0.11;
}
function detectSplices(cs: Candle[], sym: string): string[] {
  const th = spliceThresholdOf(sym);
  const out: string[] = [];
  for (let i = 1; i < cs.length; i++) {
    const p = cs[i - 1].close, c = cs[i].close;
    if (!(p > 0 && c > 0)) continue;
    if (Math.abs(c / p - 1) <= th) continue;
    const after = cs[i + 2] ? cs[i + 2].close : c; // 持續性：+2 日後仍偏離前值 = 接合（非當日波動回復）
    if (Math.abs(after / p - 1) > th * 0.8) out.push(String(cs[i].date).replace('*', ''));
  }
  return out;
}

async function main() {
  const files = (await fs.readdir(DIR)).filter((f) => /\.(SS|SZ)\.json$/.test(f));
  const affected: { sym: string; dates: string[] }[] = [];
  let detectErr = 0;

  if (VS_QFQ) {
    const CONC_DETECT = 6; // 短窗查詢比 5y 輕，但仍要避開騰訊 WAF
    let done = 0;
    for (let i = 0; i < files.length; i += CONC_DETECT) {
      await Promise.all(files.slice(i, i + CONC_DETECT).map(async (f) => {
        let cs: Candle[];
        try { cs = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8')).candles; } catch { return; }
        if (!Array.isArray(cs) || cs.length < 5) return;
        const sym = f.replace('.json', '');
        try {
          const dates = await detectViaQfq(sym, cs);
          if (dates.length) affected.push({ sym, dates });
        } catch { detectErr++; }
      }));
      done += CONC_DETECT;
      if (done % 600 === 0) console.log(`  偵測中 ${Math.min(done, files.length)}/${files.length}…命中 ${affected.length}`);
    }
    console.log(`qfq 報酬對比（近 ${DAYS} 日）：${files.length} 檔掃完，抓取失敗 ${detectErr}`);
  } else {
    for (const f of files) {
      let cs: Candle[];
      try { cs = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8')).candles; } catch { continue; }
      if (!Array.isArray(cs)) continue;
      const sym = f.replace('.json', '');
      const dates = detectSplices(cs, sym);
      if (dates.length) affected.push({ sym, dates });
    }
  }
  console.log(`偵測到未還權接合：${affected.length} 檔 / ${affected.reduce((s, a) => s + a.dates.length, 0)} 接合點`);
  if (!affected.length) return;

  if (!APPLY) {
    console.log('範例(前10):', affected.slice(0, 10).map((a) => `${a.sym}(${a.dates.length})`).join(' '));
    console.log('(dry-run，加 --apply 才重抓覆寫)');
    return;
  }

  // 備份（時間戳由外部傳入，腳本內不取 Date.now 以免每股不同；用單一資料夾）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(process.cwd(), 'data/candles', `CN-backup-splice-${stamp}`);
  await fs.mkdir(backupDir, { recursive: true });

  let ok = 0, fail = 0, still = 0;
  const CONC = 2; // 2026-06-12 降速：434×5y 併發 4 觸發騰訊 WAF
  for (let i = 0; i < affected.length; i += CONC) {
    const batch = affected.slice(i, i + CONC);
    await Promise.all(batch.map(async ({ sym }) => {
      try {
        await fs.copyFile(path.join(DIR, `${sym}.json`), path.join(backupDir, `${sym}.json`)).catch(() => {});
        const qfq = await tencentHistProvider.getHistoricalCandles(sym, '5y');
        if (!qfq || qfq.length < 60) { fail++; console.warn(`  ✗ ${sym}: qfq n/a (${qfq?.length ?? 0})`); return; }
        // 純 qfq（今日錨點）內部自洽；必須「整段取代」而非 merge —— merge 會把舊錨點殘 bar
        // 混進來重新製造接合。刪原檔 + invalidateEntry 清 L1 記憶體快取（否則 bulk preload 的舊資料
        // 會在 writeCandleFile 被當 existing merge 回來）→ saveLocalCandles 讀不到 existing、直接寫 qfq。
        await fs.unlink(path.join(DIR, `${sym}.json`)).catch(() => {});
        invalidateEntry(sym, 'CN');
        await saveLocalCandles(sym, 'CN', qfq.map((c) => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })));
        // 重驗
        const after = JSON.parse(await fs.readFile(path.join(DIR, `${sym}.json`), 'utf8')).candles as Candle[];
        // still>0 多為良性：qfq 序列「除權日撞漲停」報酬 11-13% 與復牌/新股無漲跌幅日是
        // 數學正確的真實事件（known-anomalies: cn-qfq-exdate-limit-move，2026-06-12 驗證
        // 350 檔殘留全屬此類）。refetch 冪等 — still 高不代表修復失敗。
        if (detectSplices(after, sym).length) { still++; }
        ok++;
      } catch (e) { fail++; console.warn(`  ✗ ${sym}: ${e instanceof Error ? e.message : e}`); }
    }));
    if ((i + CONC) % 40 === 0 || i + CONC >= affected.length) console.log(`  [${Math.min(i + CONC, affected.length)}/${affected.length}] ok=${ok} fail=${fail} still=${still}`);
  }
  console.log(`\n完成：修復 ${ok} 檔，失敗 ${fail}，仍殘留 ${still}。備份在 ${path.basename(backupDir)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
