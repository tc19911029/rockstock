import type { InstitutionalRecord } from '@/lib/datasource/TWSEInstitutional';
import type { InstDay } from '@/lib/chips/types';
import { writeInstStock } from '@/lib/chips/ChipStorage';

export interface InstitutionalDailySyncStats {
  requested: number;
  written: number;
  zeroFilled: number;
  missing: number;
}

/** 官方日表使用「股」，逐股籌碼 L1 統一存「張」。 */
export function institutionalRecordToInstDay(record: InstitutionalRecord): InstDay {
  const foreign = Math.round(record.foreign / 1000);
  const trust = Math.round(record.trust / 1000);
  const dealer = Math.round(record.dealer / 1000);
  return { foreign, trust, dealer, total: foreign + trust + dealer };
}

/**
 * 把單日官方全市場資料同步到掃描真正使用的逐股快取。
 *
 * sourceReady 表示該股票所屬市場的官方表本次成功。成功表中沒有該代號代表當日法人
 * 無交易，應寫 0；來源本身失敗則不可把未知值誤寫成 0。
 */
export async function syncInstitutionalDailyToStockCache(args: {
  date: string;
  records: readonly InstitutionalRecord[];
  universe: readonly string[];
  sourceReady: { twse: boolean; tpex: boolean };
}): Promise<InstitutionalDailySyncStats> {
  const byCode = new Map(args.records.map(record => [record.symbol.trim(), record]));
  const jobs: Array<{ code: string; row: InstDay; zeroFilled: boolean }> = [];
  let missing = 0;

  for (const symbol of args.universe) {
    const code = symbol.replace(/\.(TW|TWO)$/i, '').trim();
    if (!/^\d{4,5}$/.test(code)) continue;
    const record = byCode.get(code);
    if (record) {
      jobs.push({ code, row: institutionalRecordToInstDay(record), zeroFilled: false });
      continue;
    }
    const sourceAvailable = symbol.endsWith('.TWO') ? args.sourceReady.tpex : args.sourceReady.twse;
    if (sourceAvailable) {
      jobs.push({ code, row: { foreign: 0, trust: 0, dealer: 0, total: 0 }, zeroFilled: true });
    } else {
      missing++;
    }
  }

  let written = 0;
  const concurrency = 32;
  for (let i = 0; i < jobs.length; i += concurrency) {
    const results = await Promise.allSettled(jobs.slice(i, i + concurrency).map(({ code, row }) =>
      writeInstStock(code, [{ date: args.date, ...row }]),
    ));
    written += results.filter(result => result.status === 'fulfilled').length;
  }

  return {
    requested: jobs.length + missing,
    written,
    zeroFilled: jobs.filter(job => job.zeroFilled).length,
    missing,
  };
}
