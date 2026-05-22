/**
 * Technical Source — 朱老師策略全集
 *
 * 不重算技術指標，只從 L4 的多個 mtfMode session 收集已選出的股票，
 * 合併去重後產出 SourceResult。
 *
 * 涵蓋 mtfModes：
 *   - 'daily' (A 軌六條件)
 *   - 'mtf' (長線保護短線)
 *   - 'B', 'C', 'E', 'J', 'K', 'L', 'M', 'P' (bullish 軌)
 *   - 'D', 'F', 'N', 'O' (reversal 軌)
 *   - 'Q' (system 軌)
 *   - 'R' (mechanical 軌)
 *
 * 注意：不打 LLM、不重算 — 純讀 L4 結果並做 attribution。
 */

import { loadScanSession } from '@/lib/storage/scanStorage';
import type { MarketId, MtfMode, StockScanResult } from '@/lib/scanner/types';
import type {
  CandidateSources,
  SourceCandidate,
  SourceExtractor,
  SourceResult,
  TechnicalSourceAttribution,
} from '../types';

const TECHNICAL_TRACKS: MtfMode[] = [
  'daily', 'mtf',
  'B', 'C', 'E', 'J', 'K', 'L', 'M', 'P',  // bullish 軌
  'D', 'F', 'N', 'O',                       // reversal 軌
  'Q',                                       // system 軌
  'R',                                       // mechanical 軌
];

export const technicalSource: SourceExtractor = {
  source: 'technical',
  async extract({ market, date }) {
    try {
      // 並行載入所有軌
      const sessions = await Promise.all(
        TECHNICAL_TRACKS.map(async (mtf) => {
          try {
            const s = await loadScanSession(market, date, 'long', mtf);
            return { mtf, session: s };
          } catch (err) {
            return { mtf, session: null, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );

      // 對每檔股票收集它命中的軌道
      const trackHits = new Map<string, {
        row: StockScanResult;
        tracks: Set<string>;
      }>();

      for (const { mtf, session } of sessions) {
        if (!session || !session.results) continue;
        for (const r of session.results) {
          if (!r.symbol) continue;
          const existing = trackHits.get(r.symbol);
          if (existing) {
            existing.tracks.add(mtf);
          } else {
            trackHits.set(r.symbol, { row: r, tracks: new Set([mtf]) });
          }
        }
      }

      const candidates: SourceCandidate[] = [];
      for (const [symbol, { row, tracks }] of trackHits) {
        const reasons: string[] = [];
        if (row.sixConditionsScore >= 5) {
          reasons.push(`六條件 ${row.sixConditionsScore}/6`);
        }
        if (row.trendState === '多頭') {
          reasons.push(`日線多頭（${row.trendPosition ?? ''}）`);
        }
        if (row.matchedMethods && row.matchedMethods.length > 0) {
          reasons.push(`命中 ${row.matchedMethods.length} 個買法: ${row.matchedMethods.join('/')}`);
        }
        if (row.mtfWeeklyPass === true) {
          reasons.push('週線通過 (MTF)');
        }
        if (row.highWinRateScore && row.highWinRateScore > 0) {
          reasons.push(`高勝率位置 +${row.highWinRateScore}`);
        }

        const prohibitionHit =
          !!row.entryProhibitionReasons?.length ||
          !!row.longProhibitionsReasons?.length;
        const eliminationHit = !!row.eliminationReasons?.length;

        const attribution: TechnicalSourceAttribution = {
          matchedMethods: row.matchedMethods ?? [],
          sixConditionsScore: row.sixConditionsScore ?? 0,
          tracks: [...tracks],
          reasons,
          prohibitionHit,
          eliminationHit,
        };

        candidates.push({
          symbol,
          name: row.name,
          market: row.market,
          industry: row.industry,
          attribution: attribution as CandidateSources['technical'],
        });
      }

      return { source: 'technical', ran: true, candidates };
    } catch (err) {
      return {
        source: 'technical',
        ran: false,
        error: err instanceof Error ? err.message : String(err),
        candidates: [],
      };
    }
  },
};
