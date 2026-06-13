/**
 * sanse-notify — 三色（雙B / 主力狀態 / 捕撈季節）買賣結論 → 手機推播
 *
 * 取代舊的「盤中分時爆量」ntfy 通知。監看清單＝所有持倉人（profiles）目前 open 持倉
 * 的聯集（2026-06-12 改，取代手寫 data/realtime/sanse-watch.json；持倉增減自動跟上），
 * 盤中即時評估，三色一翻成「該買🟢 / 該賣🔻」就推一次。
 *
 * 設計（守住鐵則 #3 不逐檔掃、#4 走圖獨立）：
 *   不重寫「載 L1 + 注入今日盤中半根 + 對齊指數 + 量能彩柱」那段 —
 *   直接打同 server 的三色走圖 route（/api/{cn,tw}-sanse/chart/{symbol}），
 *   取回傳的 conditions(ConditionReport) → 跑純函式 tradeVerdict() → buy/sell 才推。
 *
 * 去重（鏡像 lib/realtime/alertDispatcher 的 jsonl 帳本 idiom）：
 *   key = `${tradingDay}:${symbol}:${tone}`，同一交易日同檔同方向只推一次；
 *   帳本＝當日 data/realtime/sanse-alerts/{date}.jsonl，啟動/HMR 後 reload，重啟不重推。
 *   （台北 / 上海 同為 UTC+8，交易日字串一致 → 兩市場共用單一日期。）
 *
 * Query：
 *   ?force=1  略過開盤 gate（盤後/測試評估封存後的最終 bar）
 *   ?dry=1    只算 + 回 verdict，不送 ntfy、不寫去重帳本（純檢視）
 *
 * Env：NTFY_ENABLED + NTFY_TOPIC_URL（與既有爆量通知共用 sendNtfy）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { sendNtfy, type NtfyPayload } from '@/lib/notify/ntfy';
import { tradeVerdict, type ConditionReport } from '@/lib/cn-sanse/conditions';
import { isMarketOpen, isPostCloseWindow } from '@/lib/datasource/marketHours';
import { listAllProfilesOpenStockHoldings } from '@/lib/agents/portfolio/storage';

export const runtime = 'nodejs';

interface WatchItem { symbol: string; name: string }

interface SanseAlertRecord {
  firedAt: number;            // wall-clock ms
  date: string;               // UTC+8 交易日
  symbol: string;             // 3661.TW / 600487.SS
  name: string;
  market: 'TW' | 'CN';
  tone: 'buy' | 'sell';
  reversal?: boolean;         // 底反該買（該買裡的最高把握，回測兩市場 OOS 最強）
  reason: string;
  comboLabel?: string;
  buyLabels?: string[];
  price: number;
  changePct: number;
  notified: boolean;
  notifyError?: string;
}

// ── 去重帳本（module state，鏡像 alertDispatcher.firedKeys）─────────────────
const firedKeys = new Set<string>();
let firedKeysLoadedForDate: string | null = null;

function todayUtc8(): string {
  // 台北/上海同為 UTC+8 → 兩市場交易日字串一致，用單一日期當帳本檔名與去重前綴
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

function alertsFile(date: string): string {
  return path.join(process.cwd(), 'data', 'realtime', 'sanse-alerts', `${date}.jsonl`);
}

/** 第一次（或跨日後第一次）評估時把今日 jsonl 已推播的 record 載回 firedKeys，避免重啟/HMR 後重推。 */
async function ensureFiredKeysLoaded(date: string): Promise<void> {
  if (firedKeysLoadedForDate === date) return;
  firedKeys.clear();
  firedKeysLoadedForDate = date;
  try {
    const raw = await fs.readFile(alertsFile(date), 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as SanseAlertRecord;
        firedKeys.add(`${r.date}:${r.symbol}:${r.tone}`);
      } catch { /* skip 壞行 */ }
    }
  } catch { /* 今日尚無檔 */ }
}

async function appendJsonl(date: string, records: SanseAlertRecord[]): Promise<void> {
  const dir = path.join(process.cwd(), 'data', 'realtime', 'sanse-alerts');
  await fs.mkdir(dir, { recursive: true });
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await fs.appendFile(alertsFile(date), text, 'utf-8');
}

async function loadWatch(): Promise<WatchItem[]> {
  try {
    return await listAllProfilesOpenStockHoldings();
  } catch {
    return [];
  }
}

function metSignalLabels(groups: ConditionReport['doubleB'][]): string[] {
  return groups.flatMap((g) => g.buy.filter((c) => c.kind === 'signal' && c.met).map((c) => c.label));
}

function buildPayload(rec: SanseAlertRecord): NtfyPayload {
  const code = rec.symbol.split('.')[0];
  const pct = `${rec.changePct >= 0 ? '+' : ''}${rec.changePct}%`;
  const close = `收 ${rec.price} (${pct})`;
  if (rec.tone === 'buy') {
    const parts = [rec.reason];
    if (rec.comboLabel) parts.push(rec.comboLabel);
    if (rec.buyLabels && rec.buyLabels.length) parts.push(rec.buyLabels.join('、'));
    parts.push(close);
    // 底反該買 = 回測兩市場 OOS 最高把握 → 最高優先 + 🔥 標題
    if (rec.reversal) return { title: `🔥 ${rec.name} ${code} 底反該買`, message: parts.join('｜'), tags: ['fire'], priority: 5 };
    return { title: `🟢 ${rec.name} ${code} 該買`, message: parts.join('｜'), tags: ['green_circle'], priority: 4 };
  }
  return { title: `🔻 ${rec.name} ${code} 該賣`, message: [rec.reason, close].join('｜'), tags: ['red_circle', 'warning'], priority: 5 };
}

interface EvalResult {
  symbol: string;
  name: string;
  market: 'TW' | 'CN';
  skip?: string;
  tone?: ReturnType<typeof tradeVerdict>['tone'];
  reversal?: boolean;
  reason?: string;
  price?: number;
  changePct?: number;
  buyLabels?: string[];
  comboLabel?: string;
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const dry = url.searchParams.get('dry') === '1';

  const date = todayUtc8();
  const watch = await loadWatch();
  const port = process.env.PORT || '3000';
  const base = `http://localhost:${port}`;

  // 並行打各檔三色走圖 route，取 conditions → tradeVerdict（fetch/驗證互不依賴）
  const evals: EvalResult[] = await Promise.all(
    watch.map(async (w): Promise<EvalResult> => {
      const isCN = /\.(SS|SZ)$/i.test(w.symbol);
      const market: 'TW' | 'CN' = isCN ? 'CN' : 'TW';
      const base0: EvalResult = { symbol: w.symbol, name: w.name, market };

      // 盤中即時 gate：該市場開盤（含盤後窗口讓收盤那根定論）才評；force/dry 略過
      if (!force && !dry && !isMarketOpen(market) && !isPostCloseWindow(market)) {
        return { ...base0, skip: 'market-closed' };
      }

      try {
        const chartPath = isCN
          ? `/api/cn-sanse/chart/${w.symbol}`
          : `/api/tw-sanse/chart/${w.symbol.replace(/\.(TW|TWO)$/i, '')}`;
        const res = await fetch(`${base}${chartPath}`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return { ...base0, skip: `chart-${res.status}` };
        const json = await res.json() as { ok?: boolean; conditions?: ConditionReport; price?: number; changePct?: number };
        if (!json.ok || !json.conditions) return { ...base0, skip: 'no-conditions' };

        const cr = json.conditions;
        const { tone, reason, reversal } = tradeVerdict(cr);
        return {
          ...base0,
          tone,
          reversal,
          reason,
          price: json.price ?? 0,
          changePct: json.changePct ?? 0,
          buyLabels: metSignalLabels([cr.doubleB, cr.mainforce, cr.catch]),
          comboLabel: cr.combo?.label,
        };
      } catch {
        return { ...base0, skip: 'chart-fetch-failed' };
      }
    }),
  );

  if (!dry) await ensureFiredKeysLoaded(date);

  const details: Array<Record<string, unknown>> = [];
  const toWrite: SanseAlertRecord[] = [];
  let evaluated = 0;
  let fired = 0;
  let skipped = 0;

  // 依序處理 dedup + 送推（firedKeys 為共享狀態，送推循序最穩）
  for (const e of evals) {
    if (e.skip) {
      skipped++;
      details.push({ symbol: e.symbol, skip: e.skip });
      continue;
    }
    evaluated++;
    const d: Record<string, unknown> = { symbol: e.symbol, tone: e.tone, reason: e.reason, price: e.price, changePct: e.changePct };
    details.push(d);

    if (e.tone !== 'buy' && e.tone !== 'sell') continue;

    // 底反該買用獨立 dedup 後綴 → 即使先前已推過普通「該買」，升級成底反時仍會再推一次最高把握
    const key = `${date}:${e.symbol}:${e.tone}${e.reversal ? ':rev' : ''}`;
    if (!dry && firedKeys.has(key)) { d.deduped = true; continue; }

    const rec: SanseAlertRecord = {
      firedAt: Date.now(),
      date,
      symbol: e.symbol,
      name: e.name,
      market: e.market,
      tone: e.tone,
      reversal: e.reversal,
      reason: e.reason ?? '',
      comboLabel: e.comboLabel,
      buyLabels: e.buyLabels,
      price: e.price ?? 0,
      changePct: e.changePct ?? 0,
      notified: false,
    };

    if (dry) { d.wouldFire = true; fired++; continue; }

    const sendResult = await sendNtfy(buildPayload(rec));
    rec.notified = sendResult.ok;
    if (!sendResult.ok) rec.notifyError = sendResult.error ?? sendResult.reason;
    firedKeys.add(key);
    toWrite.push(rec);
    fired++;
    d.fired = true;
    d.notified = sendResult.ok;
  }

  if (!dry && toWrite.length) {
    try {
      await appendJsonl(date, toWrite);
    } catch (err) {
      console.warn('[sanse-notify] append jsonl failed:', err);
    }
  }

  return apiOk({ date, watch: watch.length, evaluated, fired, skipped, dry, force, details });
}
