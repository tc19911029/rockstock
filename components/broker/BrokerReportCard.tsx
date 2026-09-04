'use client';

/**
 * BrokerReportCard — 單一券商報告對單一股票的卡片
 *
 * Row 1: 代號 + 名稱 + 評等 badge + 評等動作 + 券商 chip
 * Row 2: 🎯 目標價（報告日上漲空間）+ 現價距標 + 達標進度條
 * Row 3: 投資論點 thesis
 * Row 4: N 日漲跌（開盤缺口/買進後1-10/20/最高最低）— 與 YoutubeStockCard 同格式
 */

import type { BrokerStockPerformance } from '@/lib/broker/brokerPerformance';
import { ratingLabel, ratingBadgeClass, ratingActionLabel } from './sentimentFromRating';

interface Props {
  item: BrokerStockPerformance;
  selected?: boolean;
  onSelect?: (code: string) => void;
}

function fmtRet(val: number | null | undefined): string {
  if (val == null) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}
function retColor(val: number | null | undefined): string {
  if (val == null) return 'text-muted-foreground/50';
  if (val > 0) return 'text-bull';
  if (val < 0) return 'text-bear';
  return 'text-muted-foreground';
}
function fmtPrice(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const FWD_COLS = [
  { key: 'openReturn' as const, label: '開盤缺口' },
  { key: 'd1Return' as const, label: '1日' },
  { key: 'd2Return' as const, label: '2日' },
  { key: 'd3Return' as const, label: '3日' },
  { key: 'd4Return' as const, label: '4日' },
  { key: 'd5Return' as const, label: '5日' },
  { key: 'd6Return' as const, label: '6日' },
  { key: 'd7Return' as const, label: '7日' },
  { key: 'd8Return' as const, label: '8日' },
  { key: 'd9Return' as const, label: '9日' },
  { key: 'd10Return' as const, label: '10日' },
  { key: 'd20Return' as const, label: '20日' },
  { key: 'maxGain' as const, label: '最高' },
  { key: 'maxLoss' as const, label: '最低' },
] as const;

export function BrokerReportCard({ item, selected, onSelect }: Props) {
  const t = item.target;
  const action = ratingActionLabel(item.rating_action);
  const tpRaised = item.prev_target_price != null && item.target_price != null && item.target_price !== item.prev_target_price;
  const perf = item.performance;
  const isTw = item.market === 'TW' && item.stock_code != null;

  // 達標進度條：0=報告價、100=目標價，clamp 0..100
  const progClamped = t.progressPct == null ? null : Math.max(0, Math.min(100, t.progressPct));

  return (
    <div
      className={`rounded-lg border px-2.5 py-2 transition-colors ${isTw ? 'cursor-pointer' : ''} ${
        selected
          ? 'bg-secondary/60 border-rose-600/60 ring-1 ring-rose-500/40'
          : 'bg-card border-border/60 hover:bg-secondary/40'
      }`}
      onClick={() => { if (isTw && item.stock_code) onSelect?.(item.stock_code); }}
    >
      {/* Row 1: 代號 + 名稱 + 評等 + 動作 + 券商 */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className="font-mono text-[11px] text-foreground/90 shrink-0">{item.stock_code ?? '—'}</span>
        <span className="text-[11px] text-foreground/80 truncate flex-1">{item.stock_name}</span>
        <span
          className={`text-[9px] px-1.5 h-3.5 flex items-center rounded-sm border font-bold ${ratingBadgeClass(item.rating)}`}
          title={`評等原文：${item.rating_raw || '（純提及）'}`}
        >
          {item.rating_raw && item.rating !== 'other' ? ratingLabel(item.rating) : '提及'}
        </span>
        {action && <span className={`text-[9px] font-bold shrink-0 ${action.cls}`}>{action.text}</span>}
        <span className="text-[9px] px-1 h-3.5 flex items-center rounded-sm bg-secondary/60 text-foreground/70 border border-border/50 shrink-0" title={item.report_title}>
          🏦 {item.broker_display}
        </span>
      </div>

      {/* Row 2: 目標價 + 達標度 */}
      {item.target_price != null ? (
        <div className="flex items-center gap-1.5 mb-1 text-[10px]">
          {t.currencyMismatch ? (
            <span className="text-muted-foreground" title="目標價幣別非台幣，與台股股價不可直接比較">
              🎯 {item.report_currency} {fmtPrice(item.target_price)}（外幣·不計達標度）
            </span>
          ) : (
            <>
              <span className="text-foreground/80 shrink-0">
                🎯 {fmtPrice(item.target_price)}
                {tpRaised && (
                  <span className="text-muted-foreground/70 ml-0.5" title="目標價調整">
                    （{fmtPrice(item.prev_target_price)}→<span className={item.target_price! > item.prev_target_price! ? 'text-bull' : 'text-bear'}>{fmtPrice(item.target_price)}</span>）
                  </span>
                )}
              </span>
              {t.upsideAtReport != null && (
                <span className={`shrink-0 ${retColor(t.upsideAtReport)}`} title="報告日：目標價相對報告日收盤的上漲空間">
                  報告 {fmtRet(t.upsideAtReport)}
                </span>
              )}
              {t.reached ? (
                <span className="text-bull font-bold shrink-0">已達標 ✓</span>
              ) : t.distanceToTargetPct != null && (
                <span className="text-muted-foreground shrink-0" title="現價距目標價">距標 {fmtRet(t.distanceToTargetPct)}</span>
              )}
              {progClamped != null && (
                <div className="flex-1 h-1.5 bg-muted/40 rounded-full overflow-hidden min-w-[40px]" title={`達標進度 ${t.progressPct?.toFixed(0)}%`}>
                  <div
                    className={`h-full rounded-full ${t.reached ? 'bg-bull' : 'bg-rose-500/70'}`}
                    style={{ width: `${progClamped}%` }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="text-[10px] text-muted-foreground/70 mb-1">🎯 無目標價（純提及/族群報告）</div>
      )}

      {/* Row 3: thesis */}
      {item.thesis && (
        <div className="text-[10px] text-foreground/70 mb-1 line-clamp-2 leading-snug" title={item.thesis}>
          「{item.thesis}」
        </div>
      )}

      {/* Row 4: N 日漲跌 */}
      {!isTw ? (
        <div className="text-[9px] text-muted-foreground/70 italic py-0.5">🌐 非台股，不追蹤漲跌幅</div>
      ) : (() => {
        const allEmpty = FWD_COLS.every(({ key }) => perf[key] == null);
        if (allEmpty) {
          return (
            <div className="text-[9px] text-muted-foreground/70 italic flex items-center gap-1 py-0.5"
              title={perf.status === 'no_data' ? '無 K 線資料' : '報告日太新，尚未結算'}>
              <span>📅</span>
              <span>{perf.status === 'no_data' ? '無 K 線資料' : 'N 日漲跌待結算'}</span>
            </div>
          );
        }
        return (
          <div className="flex items-center gap-0.5" title={`報告日收盤 ${perf.baseClose?.toFixed(2) ?? '—'}`}>
            {FWD_COLS.map(({ key, label }) => {
              const val = perf[key];
              return (
                <div key={key} className="flex-1 text-center">
                  <div className="text-[8px] text-muted-foreground/60">{label}</div>
                  <div className={`text-[9px] font-mono ${retColor(val)}`}>{fmtRet(val)}</div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}
