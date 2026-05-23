/**
 * 每日 analysis → Markdown 報告（MVP 6）。
 *
 * 給 /api/youtube/report/[date]?format=md 用。
 * 也可被 server-side 寫成 .md 檔備存。
 */

import type { DailyAnalysis, AnalyzedStockMention, StockScoring } from './analysisStorage';
import { deriveStockMentions } from './analysisStorage';

function sourceLabel(id: string): string {
  // 簡短人類可讀標籤，未對映就保留原 id
  const map: Record<string, string> = {
    'tsai-wan-de': '股市得意',
    'ebc-moneyshow': '理財達人秀',
    'zhaohua-ailun': '兆華艾綸說',
    '57-stock-class': '57同學會',
    'tu-min-feng': '超越巔峰',
    'lan-deng-yao': '金融鬼谷子',
    'xu-yu-ling': '股市易點靈',
    'chen-wei-liang': '股市全威',
    'ustvmoney100': '錢線百分百',
    'ailun-live': '艾綸說直播',
    'winning-key': '決勝關鍵',
    'jinlin-tianxia': '金臨天下',
    'gumin-kaijiang': '股民開講',
  };
  return map[id] ?? id;
}

function fmtScoring(s: StockScoring | undefined): string {
  if (!s) return '—';
  return `**${s.rating}** ${s.composite_score.toFixed(1)}`;
}

function fmtSentimentCount(b: number, br: number): string {
  if (b === 0 && br === 0) return '—';
  const parts: string[] = [];
  if (b > 0) parts.push(`👍 ${b}`);
  if (br > 0) parts.push(`👎 ${br}`);
  return parts.join(' / ');
}

export function renderMarkdownReport(a: DailyAnalysis): string {
  const lines: string[] = [];

  // ── 頭 ────────────────────────────────────────────────────────
  lines.push(`# YouTube 理財節目跨節目共識 — ${a.date}`);
  lines.push('');
  lines.push(`> 產出時間：${a.generated_at}  `);
  lines.push(`> 來自 ${a.stats.videos_analyzed} 支影片 · ${a.stats.unique_stocks_total} 檔被提到`);
  if (a.stats.rating_distribution) {
    const r = a.stats.rating_distribution;
    lines.push(`> 評級分佈：A=${r.A} · B=${r.B} · C=${r.C} · D=${r.D}`);
  }
  lines.push('');

  // ── 大盤觀點 ────────────────────────────────────────────────────
  lines.push('## 大盤觀點');
  lines.push('');
  lines.push(a.market_view || '(無)');
  lines.push('');

  // ── 共識 ────────────────────────────────────────────────────────
  if (a.bullish_consensus.length > 0) {
    lines.push('## 看多共識');
    lines.push('');
    for (const x of a.bullish_consensus) lines.push(`- ${x}`);
    lines.push('');
  }
  if (a.bearish_consensus.length > 0) {
    lines.push('## 風險提醒');
    lines.push('');
    for (const x of a.bearish_consensus) lines.push(`- ${x}`);
    lines.push('');
  }

  // ── 股票表 (有 scoring) ────────────────────────────────────────
  const mentions = deriveStockMentions(a);
  if (mentions.stocks.length > 0) {
    lines.push('## 今日提到的股票');
    lines.push('');
    lines.push('| 代號 | 名稱 | 評級 | 總分 | 提及次數 | 看多/看空 | 信心 | 節目情緒 | 建議 |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    const ratingOrder: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };
    const sorted = [...mentions.stocks].sort((x, y) => {
      const xr = x.scoring ? ratingOrder[x.scoring.rating] : 0;
      const yr = y.scoring ? ratingOrder[y.scoring.rating] : 0;
      if (xr !== yr) return yr - xr;
      return y.mention_count - x.mention_count;
    });
    for (const s of sorted) {
      const sentimentLabel =
        s.bullish_count > s.bearish_count ? '看多'
        : s.bearish_count > s.bullish_count ? '看空'
        : s.mention_count > 0 ? '提及' : '—';
      const scoringStr = s.scoring
        ? `**${s.scoring.rating}** | ${s.scoring.composite_score.toFixed(1)}`
        : '— | —';
      const action = s.scoring?.action ?? '—';
      lines.push(
        `| ${s.stock_code} | ${s.stock_name} | ${scoringStr} | ${s.mention_count} | ${fmtSentimentCount(s.bullish_count, s.bearish_count)} | ${s.best_confidence.toFixed(2)} | ${sentimentLabel} | ${action} |`,
      );
    }
    lines.push('');
  }

  // ── A 級股票詳細推介 ────────────────────────────────────────────
  const aGradeStocks = (a.stock_scoring ?? []).filter(s => s.rating === 'A');
  if (aGradeStocks.length > 0) {
    lines.push('## A 級股票詳細推介');
    lines.push('');
    for (const sc of aGradeStocks) {
      lines.push(`### ${sc.stock_code} ${sc.stock_name} — ${sc.composite_score.toFixed(1)} 分`);
      lines.push('');
      lines.push(`- **動作**：${sc.action}`);
      const f = sc.factor_scores;
      lines.push(`- **因子分數**：技術 ${f.technical} · 籌碼 ${f.chip} · 基本面 ${f.fundamental} · 消息 ${f.news} · 熱度 ${f.mention_heat} · 產業 ${f.industry} · 大盤 ${f.macro} · 估值 ${f.valuation} · 治理 ${f.governance}`);
      if (sc.risk_flags.length > 0) lines.push(`- **風險旗標**：${sc.risk_flags.join(', ')}`);
      lines.push(`- **評分依據**：${sc.reasoning}`);
      lines.push('');
    }
  }

  // ── 跨節目共識 mention 詳情（含 weak_signal 整合，顯示「每個節目+分析師說了什麼」） ──
  const allMentionsForDetail = [...a.high_consensus_stocks, ...a.weak_signal_stocks];
  if (allMentionsForDetail.length > 0) {
    lines.push('## 各股完整跨節目分析師發言（依股票分組）');
    lines.push('');
    const groupedByCode = new Map<string, AnalyzedStockMention[]>();
    for (const m of allMentionsForDetail) {
      if (!m.matched) continue;
      const code = m.matched.code;
      if (!groupedByCode.has(code)) groupedByCode.set(code, []);
      groupedByCode.get(code)!.push(m);
    }
    // 按 mention 次數降冪排序
    const sortedCodes = Array.from(groupedByCode.entries())
      .sort((a, b) => b[1].length - a[1].length);
    for (const [code, ms] of sortedCodes) {
      // 單一節目單一 mention 的不展開（避免報告過長），≥2 才展開
      if (ms.length < 2) continue;
      const name = ms[0].matched?.name ?? '';
      const sourceCount = new Set(ms.map(m => m.source_id)).size;
      lines.push(`### ${code} ${name} — ${sourceCount} 個節目、${ms.length} 條提及`);
      lines.push('');
      // 同股 mentions 依 sentiment 排序（多空優先）
      const sortedMs = [...ms].sort((a, b) => {
        const order: Record<string, number> = { bullish: 1, bearish: 2, risk_warning: 3, watchlist: 4, neutral: 5, mentioned_only: 6 };
        return (order[a.sentiment] ?? 9) - (order[b.sentiment] ?? 9);
      });
      for (const m of sortedMs) {
        const analystLabel = m.analysts && m.analysts.length > 0
          ? `（${m.analysts.join(' / ')}）`
          : '';
        lines.push(`- **${sourceLabel(m.source_id)}**${analystLabel} [${m.sentiment}]`);
        lines.push(`  - 原話：${m.context}`);
        if (m.reason && m.reason !== m.context) {
          lines.push(`  - 理由：${m.reason}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('_本報告由 rockstock YouTube tracker 自動匯出。所有評級為 LLM 基於主持人原話 + 程式取得的事實資料推算，僅供參考，非投資建議。_');

  return lines.join('\n');
}
