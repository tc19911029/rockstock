/**
 * GET /api/realtime/alerts/today
 *
 * 跨 symbol 聚合：今日所有 realtime alerts + group by symbol 取最新。
 *
 * 用於：
 *   - 主頁 TodayBriefing 顯示「盤中警示」列表
 *   - DecisionPanel HoldingBadge 對應 symbol 顯示最近警示 chip
 *
 * Storage：data/realtime/alerts/{date}.jsonl （由 lib/realtime/alertDispatcher 寫入）
 */

import { apiOk } from '@/lib/api/response';
import { listRecentAlerts, type AlertRecord } from '@/lib/realtime/alertDispatcher';

export const runtime = 'nodejs';

export async function GET() {
  const alerts = await listRecentAlerts(50);
  // listRecentAlerts 內部已按時間反序（newest first）讀今日 jsonl
  const sorted = [...alerts].sort((a, b) => b.firedAt - a.firedAt);

  // group by symbol 取最新
  const bySymbol: Record<string, AlertRecord> = {};
  for (const alert of sorted) {
    if (!bySymbol[alert.symbol]) {
      bySymbol[alert.symbol] = alert;
    }
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

  return apiOk({
    date: today,
    count: sorted.length,
    alerts: sorted,
    bySymbol,
  });
}
