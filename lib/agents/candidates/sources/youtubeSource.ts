/**
 * YouTube Source — 從 YouTube 跨節目 analysis 取候選
 *
 * 讀 data/youtube/analysis/{date}.json：
 *   - high_consensus_stocks (≥2 節目同向)
 *   - weak_signal_stocks (單一節目或意見分歧)
 *
 * 兩類都丟進 pool，attribution 帶 inHighConsensus / mentionCount 等供排序。
 *
 * §0 隔離：這個 source 不評估技術面，只彙整節目資訊。
 */

import { fetchJSON, internalUrl } from '@/lib/agents/agents/_fetchHelper';
import type { AnalyzedStockMention, DailyAnalysis } from '@/lib/youtube/analysisStorage';
import type {
  CandidateSources,
  SourceCandidate,
  SourceExtractor,
  SourceResult,
  YouTubeSourceAttribution,
} from '../types';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

export const youtubeSource: SourceExtractor = {
  source: 'youtube',
  async extract({ market, date }): Promise<SourceResult> {
    if (market !== 'TW') {
      // YouTube analysis 目前只覆蓋台股節目
      return { source: 'youtube', ran: true, candidates: [] };
    }

    try {
      const raw = await fetchJSON(internalUrl(`/api/youtube/analysis/${date}`));
      if (!raw || typeof raw !== 'object') {
        return { source: 'youtube', ran: true, candidates: [], error: 'analysis not found' };
      }
      const wrapper = raw as { analysis?: DailyAnalysis | null };
      const analysis = wrapper.analysis;
      if (!analysis) {
        return { source: 'youtube', ran: true, candidates: [] };
      }

      // 對每檔股票聚合所有提及（high + weak）
      const grouped = new Map<string, AnalyzedStockMention[]>();

      const addMentions = (mentions: AnalyzedStockMention[] | undefined): void => {
        if (!mentions) return;
        for (const m of mentions) {
          if (!m.matched) continue;
          const code = m.matched.code;
          if (!code) continue;
          const arr = grouped.get(code) ?? [];
          arr.push(m);
          grouped.set(code, arr);
        }
      };

      addMentions(analysis.high_consensus_stocks);
      addMentions(analysis.weak_signal_stocks);

      // 從 stocklist 拿 TWSE vs TPEx 分類（authoritative source）
      // 不要用 4-digit 硬寫 .TW — 上櫃股寫成 .TW 會建 ghost 檔，被 retry-failed cron 每天重抓變污染源
      const tpexCodeSet = new Set<string>();
      const twseCodeSet = new Set<string>();
      if (market === 'TW') {
        try {
          const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
          const stocks = await new TaiwanScanner().getStockList();
          for (const s of stocks) {
            const c = s.symbol.replace(/\.(TW|TWO)$/, '');
            if (s.symbol.endsWith('.TWO')) tpexCodeSet.add(c);
            else if (s.symbol.endsWith('.TW')) twseCodeSet.add(c);
          }
        } catch (err) {
          console.warn('[youtubeSource] stocklist load failed, suffix fallback to .TW:', err);
        }
      }

      const candidates: SourceCandidate[] = [];

      for (const [code, mentions] of grouped) {
        const shows = new Set<string>();
        let confSum = 0;
        const sentCounts = new Map<string, number>();
        let inHigh = false;
        for (const m of mentions) {
          if (m.source_id) shows.add(m.source_id);
          confSum += m.combined_confidence;
          sentCounts.set(m.sentiment, (sentCounts.get(m.sentiment) ?? 0) + 1);
        }
        // 是否曾出現於 high_consensus_stocks
        inHigh = !!analysis.high_consensus_stocks?.some(m => m.matched?.code === code);

        const sentiment = [...sentCounts.entries()]
          .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral';

        const first = mentions[0];
        if (!first?.matched) continue;

        const reasons: string[] = [];
        if (inHigh) reasons.push(`高共識：${mentions.length} 節目同向（${sentiment}）`);
        else reasons.push(`弱信號：${mentions.length} 節目提到`);
        if (shows.size > 0) {
          reasons.push(`節目：${[...shows].slice(0, 3).join('、')}${shows.size > 3 ? '...' : ''}`);
        }

        // 用台股代號補 suffix（同 L4 symbol 格式以利合併）
        // TPEx 上櫃股必須用 .TWO，否則會建 ghost .TW 檔（見上方 stocklist 載入區註解）
        const isFourDigits = /^\d{4,6}$/.test(code);
        let symbol: string;
        if (isFourDigits && market === 'TW') {
          if (tpexCodeSet.has(code)) symbol = `${code}.TWO`;
          else if (twseCodeSet.has(code)) symbol = `${code}.TW`;
          else symbol = `${code}.TW`; // 未知 code（stocklist 載入失敗或新股），預設上市
        } else {
          symbol = code;
        }

        const attribution: YouTubeSourceAttribution = {
          mentionCount: mentions.length,
          shows: [...shows],
          sentiment,
          inHighConsensus: inHigh,
          combinedConfidence: mentions.length > 0 ? confSum / mentions.length : 0,
          reasons,
        };

        candidates.push({
          symbol,
          name: stockDisplayName(first.matched.name, code),
          market,
          attribution: attribution as CandidateSources['youtube'],
        });
      }

      return { source: 'youtube', ran: true, candidates };
    } catch (err) {
      return {
        source: 'youtube',
        ran: false,
        error: err instanceof Error ? err.message : String(err),
        candidates: [],
      };
    }
  },
};
