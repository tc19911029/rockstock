/**
 * Backtest Report PDF Generator — client-side PDF creation using pdfmake.
 *
 * Generates a backtest summary report including:
 * 1. Scan parameters (date, market, strategy, mode)
 * 2. Performance stats (win rate, Sharpe, drawdown, etc.)
 * 3. Trade list with entry/exit details
 * 4. Disclaimer
 */
import type { BacktestTrade, BacktestStats } from '@/lib/backtest/BacktestEngine';
import type { MarketId } from '@/lib/scanner/types';

interface BacktestReportData {
  market: MarketId;
  scanDate: string;
  strategy: string;
  scanMode: string;
  resultCount: number;
  stats: BacktestStats;
  trades: BacktestTrade[];
  capitalMode?: boolean;
  initialCapital?: number;
}

/**
 * Generate and download a backtest report PDF.
 */
export async function generateBacktestPDF(data: BacktestReportData): Promise<void> {
  // Dynamic import to avoid bundling pdfmake in initial load
  const pdfMake = await import('pdfmake/build/pdfmake');
  const pdfFonts = await import('pdfmake/build/vfs_fonts');
  (pdfMake as unknown as { vfs: unknown }).vfs = (pdfFonts as unknown as { pdfMake: { vfs: unknown } }).pdfMake.vfs;

  const { market, scanDate, strategy, scanMode, resultCount, stats, trades } = data;

  const pctFmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

  // Build trade table rows
  const tradeRows = trades.slice(0, 50).map(t => [
    t.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''),
    t.entryDate,
    `$${t.entryPrice.toFixed(2)}`,
    t.exitDate,
    `$${t.exitPrice.toFixed(2)}`,
    pctFmt(t.netReturn * 100),
    t.exitReason,
  ]);

  const docDefinition = {
    pageSize: 'A4' as const,
    pageMargins: [40, 60, 40, 60] as [number, number, number, number],
    content: [
      // Title
      { text: `回測報告`, fontSize: 22, bold: true, margin: [0, 0, 0, 10] as [number, number, number, number] },
      { text: `${market} 市場 · ${scanDate} · ${strategy}`, fontSize: 12, color: '#666', margin: [0, 0, 0, 20] as [number, number, number, number] },

      // Summary stats
      { text: '績效摘要', fontSize: 16, bold: true, margin: [0, 0, 0, 10] as [number, number, number, number] },
      {
        table: {
          widths: ['*', '*', '*', '*'],
          body: [
            ['掃描結果', '交易筆數', '勝率', '期望值'],
            [`${resultCount} 檔`, `${stats.count} 筆`, `${stats.winRate}%`, pctFmt(stats.expectancy * 100)],
            ['總淨報酬', '最大回撤', 'Sharpe', '利潤因子'],
            [
              pctFmt(stats.totalNetReturn * 100),
              pctFmt(stats.maxDrawdown * 100),
              stats.sharpeRatio?.toFixed(3) ?? 'N/A',
              stats.profitFactor?.toFixed(3) ?? 'N/A',
            ],
          ],
        },
        layout: 'lightHorizontalLines',
        margin: [0, 0, 0, 20] as [number, number, number, number],
      },

      // Additional info
      {
        columns: [
          { text: `模式: ${scanMode}`, fontSize: 10, color: '#888' },
          { text: `勝: ${stats.wins} / 負: ${stats.losses}`, fontSize: 10, color: '#888' },
          { text: `跳過: ${stats.skippedCount} 筆`, fontSize: 10, color: '#888' },
        ],
        margin: [0, 0, 0, 20] as [number, number, number, number],
      },

      // Trade list
      ...(tradeRows.length > 0 ? [
        { text: `交易明細 (前 ${Math.min(trades.length, 50)} 筆)`, fontSize: 16, bold: true, margin: [0, 0, 0, 10] as [number, number, number, number] },
        {
          table: {
            headerRows: 1,
            widths: ['auto', 'auto', 'auto', 'auto', 'auto', 'auto', '*'],
            body: [
              ['代號', '進場日', '進場價', '出場日', '出場價', '報酬', '出場原因'],
              ...tradeRows,
            ],
          },
          layout: 'lightHorizontalLines',
          fontSize: 8,
          margin: [0, 0, 0, 20] as [number, number, number, number],
        },
      ] : []),

      // Disclaimer
      {
        text: '免責聲明：本報告僅供學習參考，不構成投資建議。回測結果包含手續費與稅金，但不代表未來績效。',
        fontSize: 8,
        color: '#999',
        margin: [0, 20, 0, 0] as [number, number, number, number],
      },
      {
        text: `產生時間: ${new Date().toLocaleString('zh-TW')} · Rockstock 回測引擎`,
        fontSize: 8,
        color: '#999',
      },
    ],
  };

  const pdf = pdfMake.createPdf(docDefinition);
  pdf.download(`backtest_${market}_${scanDate}.pdf`);
}
