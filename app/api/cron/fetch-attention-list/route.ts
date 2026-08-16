/**
 * Daily cron：抓 TWSE/TPEx 處置股 + 注意股官方名單
 * 盤後 17:35 CST 觸發（公布在收盤後）。寫 data/market/TW/attention/{date}.json + latest.json。
 *
 * partial 成功仍寫檔（缺的來源記進 sourceErrors）— 處置期間跨多日，
 * 寧可用少一條來源的新名單，也不要因單源失敗整天用舊檔。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import {
  fetchTwsePunish,
  fetchTwseNotice,
  fetchTpexDisposal,
  fetchTpexNotice,
  type AttentionEntry,
} from '@/lib/datasource/AttentionListProvider';
import { saveAttentionList } from '@/lib/market/attentionList';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const todayCst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

  const [punish, notice, tpexDisposal, tpexNotice] = await Promise.allSettled([
    fetchTwsePunish(),
    fetchTwseNotice(),
    fetchTpexDisposal(),
    fetchTpexNotice(),
  ]);

  const sourceErrors: string[] = [];
  const pick = (r: PromiseSettledResult<AttentionEntry[]>, label: string): AttentionEntry[] => {
    if (r.status === 'fulfilled') return r.value;
    sourceErrors.push(`${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    return [];
  };

  const entries = [
    ...pick(punish, 'twse-punish'),
    ...pick(notice, 'twse-notice'),
    ...pick(tpexDisposal, 'tpex-disposal'),
    ...pick(tpexNotice, 'tpex-notice'),
  ];

  // 四條全掛才算失敗（不寫檔，保留舊 latest）
  if (sourceErrors.length === 4) {
    return apiError(`all sources failed: ${sourceErrors.join(' | ')}`, 502);
  }

  const sourceCounts = {
    twsePunish: punish.status === 'fulfilled' ? punish.value.length : 0,
    twseNotice: notice.status === 'fulfilled' ? notice.value.length : 0,
    tpexDisposal: tpexDisposal.status === 'fulfilled' ? tpexDisposal.value.length : 0,
    tpexNotice: tpexNotice.status === 'fulfilled' ? tpexNotice.value.length : 0,
  };

  await saveAttentionList({
    fetchedAt: new Date().toISOString(),
    fetchDate: todayCst,
    entries,
    sourceCounts,
    ...(sourceErrors.length > 0 ? { sourceErrors } : {}),
  });

  return apiOk({
    date: todayCst,
    total: entries.length,
    disposal: entries.filter(e => e.kind === 'disposal').length,
    notice: entries.filter(e => e.kind === 'notice').length,
    sourceCounts,
    ...(sourceErrors.length > 0 ? { sourceErrors } : {}),
  });
}
