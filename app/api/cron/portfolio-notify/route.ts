import { NextRequest } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { apiOk } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { sendNtfy } from '@/lib/notify/ntfy';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { empiricalHeaviness, tierEmoji } from '@/lib/sell/sellHeavinessRank';
import { loadProfiles } from '@/lib/portfolio/profiles';
import type { DailyActionItem, DailyActionResponse } from '@/app/api/portfolio/daily-action/route';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * 持倉動作推播 cron（2026-06-12，A1+A3 — 停損執行差額是帳上最大錢坑）。
 *
 * 背景：/portfolio 的今日操作建議只有「打開頁面才看得到」，3006 觸發停損後
 * 一路抱到 -18.2%（書本 -7% 出場，差額 ~76 萬）。本 route 由 local-cron 每 2 分鐘
 * 打一次（盤外廉價 no-op），把 stop_loss / exit_all / reduce_half 推到 ntfy 手機。
 * 2026-06-12 起涵蓋**所有持倉人**（profiles）的 TW 持倉（daily-action 是台股資料鏈），
 * 推播標題帶持倉人名、同檔不同人分開去重（停損價各自不同）：
 *
 *   1. 盤中首次偵測 → 推一次（當日同 symbol+action 去重）
 *   2. 13:18-13:30 執行窗 → 若仍 actionable 再推一次「現在掛 13:25 市價單」
 *      （朱書時點：上漲跌破前日 K 最低 → 1:20 看、1:25 掛市價，不是 09:00 動作）
 *
 * 賣訊附實證輕重標記（A3，data/backtest/sell-heaviness.json）：
 * 🔴重（如捕撈死叉/早期見頂K）該立刻處理；⚪輕（死亡交叉等落後反指）僅供參考。
 * 純通知層 — 不下單、不改持倉，決策永遠在使用者。
 */

const STATE_FILE = path.join(process.cwd(), 'data', 'realtime', 'portfolio-notify-state.json');

interface NotifyState { date: string; sent: Record<string, true> }

function loadState(today: string): NotifyState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as NotifyState;
    if (s.date === today) return s;
  } catch { /* 首次/壞檔 → 重建 */ }
  return { date: today, sent: {} };
}

function saveState(s: NotifyState) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

const ACTIONABLE = new Set(['stop_loss', 'exit_all', 'reduce_half', 'watch_stop']);

function priorityOf(action: string): 1 | 2 | 3 | 4 | 5 {
  if (action === 'stop_loss') return 5;
  if (action === 'exit_all') return 4;
  if (action === 'reduce_half') return 4;
  return 3; // watch_stop
}

function buildMessage(it: DailyActionItem, execWindow: boolean, profileName: string): { title: string; message: string } {
  const head = execWindow ? '⏰ 13:25 執行窗 — ' : '';
  const title = `${head}${profileName}｜${it.name} ${it.label}`;
  const lines: string[] = [];
  lines.push(`${it.symbol} 現價 ${it.todayClose ?? '?'}｜報酬 ${it.profitPct != null ? it.profitPct.toFixed(1) + '%' : '?'}｜停損 ${it.stopLoss}`);
  for (const s of it.signals ?? []) {
    const h = empiricalHeaviness(s.type);
    lines.push(`${tierEmoji(h.tier)} ${s.label}${h.tier === 'heavy' ? '（實證重訊）' : h.tier === 'light' ? '（落後指標，參考）' : ''}`);
  }
  if (execWindow) {
    lines.push('朱書時點：現在看 13:20 盤勢，13:25 掛市價單。');
  } else {
    lines.push('書本規則：今日確認訊號 → 13:20 再看一次、13:25 掛市價（盤中假突破不算）。');
  }
  return { title, message: lines.join('\n') };
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);

  // 盤外廉價 no-op：交易日 09:05-13:35 才工作（09:05 起，避開開盤第一根雜訊）
  if (!isTradingDay(today, 'TW') || hm < '09:05' || hm > '13:35') {
    return apiOk({ skipped: true, reason: 'outside TW session window' });
  }
  const execWindow = hm >= '13:18' && hm <= '13:30';

  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  const host = req.headers.get('host') ?? 'localhost:3000';

  // 所有持倉人並行取各自的今日操作建議（CN-only / 純基金 profile 的 items 為空，無害）
  const { profiles } = await loadProfiles();
  const perProfile = await Promise.all(
    profiles.map(async (p): Promise<{ profile: typeof p; data?: DailyActionResponse; error?: string }> => {
      try {
        const res = await fetch(
          `${proto}://${host}/api/portfolio/daily-action?profile=${encodeURIComponent(p.id)}`,
          { signal: AbortSignal.timeout(60_000) },
        );
        const j = await res.json();
        return { profile: p, data: (j.data ?? j) as DailyActionResponse };
      } catch (e) {
        return { profile: p, error: (e as Error).message };
      }
    }),
  );
  if (perProfile.every((r) => r.error != null)) {
    return apiOk({ skipped: true, reason: `daily-action fetch failed: ${perProfile[0]?.error}` });
  }

  const state = loadState(today);
  const pushed: string[] = [];
  let checked = 0;
  for (const r of perProfile) {
    if (!r.data) continue;
    const items = r.data.items ?? [];
    checked += items.length;
    for (const it of items) {
      if (!ACTIONABLE.has(it.action)) continue;
      const phase = execWindow ? 'exec' : 'intraday';
      const key = `${r.profile.id}:${it.symbol}:${it.action}:${phase}`;
      if (state.sent[key]) continue;

      const { title, message } = buildMessage(it, execWindow, r.profile.name);
      const sent = await sendNtfy({
        title,
        message,
        tags: it.action === 'stop_loss' ? ['rotating_light'] : ['warning'],
        priority: execWindow ? 5 : priorityOf(it.action),
        click: `http://localhost:3000/portfolio`,
      });
      if (sent.ok || sent.reason === 'disabled' || sent.reason === 'no-url') {
        // disabled/no-url 也記成已送，避免 env 沒開時每 2 分鐘空轉重試刷 log
        state.sent[key] = true;
        if (sent.ok) pushed.push(key);
      }
    }
  }
  saveState(state);
  return apiOk({ pushed, execWindow, checked });
}
