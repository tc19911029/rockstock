import type { MarketId, MtfMode, ScanDirection } from './types';

export interface ScanCompletionCheck {
  completed: boolean;
  missing: string[];
  stale: string[];
}

/**
 * 驗證本輪正式掃描是否真的把每個必要 post_close 主檔寫成。
 * 空結果（resultCount=0）仍是合法完成；缺檔、intraday 假冒或舊輪檔案才算失敗。
 */
export async function verifyPostCloseScanCompletion(options: {
  market: MarketId;
  date: string;
  directions: ScanDirection[];
  mtfModes: MtfMode[];
  startedAt?: number;
  strategyId?: string;
}): Promise<ScanCompletionCheck> {
  const { loadPostCloseScanSession } = await import('@/lib/storage/scanStorage');
  const missing: string[] = [];
  const stale: string[] = [];

  for (const direction of options.directions) {
    for (const mtfMode of options.mtfModes) {
      const key = `${direction}-${mtfMode}`;
      const session = await loadPostCloseScanSession(
        options.market,
        options.date,
        direction,
        mtfMode,
        options.strategyId,
      );
      if (!session) {
        missing.push(key);
        continue;
      }
      if (options.startedAt != null) {
        const scanTime = Date.parse(session.scanTime ?? '');
        if (!Number.isFinite(scanTime) || scanTime < options.startedAt - 1_000) {
          stale.push(key);
        }
      }
    }
  }

  return {
    completed: missing.length === 0 && stale.length === 0,
    missing,
    stale,
  };
}
