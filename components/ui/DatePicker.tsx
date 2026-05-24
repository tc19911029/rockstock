'use client';

/**
 * 統一日期選擇器 — pill grid 樣式（仿首頁右側「策略掃描」tab 的設計）。
 *
 * 排版：grid-cols-11 × 2 列 = 22 個日期 pill，按日期由新到舊排序。
 * 樣式：active 用 bg-sky-700 / text-sky-100 / font-semibold；
 *       inactive 用 bg-secondary/60 / text-muted-foreground。
 *
 * 兩個 size：
 *   - md（整頁用）：text-[10px] px-1 py-0.5
 *   - sm（首頁右側 tab 用）：text-[9px] px-0.5 py-0.5（緊湊版）
 *
 * 用法：
 *   <DatePicker value={date} onChange={setDate} />                // 取最近 22 個日曆日
 *   <DatePicker value={date} onChange={setDate} dates={['...']} /> // 用呼叫端給的日期
 *   <DatePicker ... meta={{ '2026-05-22': { count: 100 } }} />     // hover 顯示「100 檔」
 */

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { fmtDateLabelTw } from '@/lib/dateDefaults';

export interface DateMeta {
  /** hover tooltip 顯示的檔數（"100 檔"），undefined 不顯示 */
  count?: number;
  /** count 的單位，預設「檔」 */
  unit?: string;
  /** 額外 hover 註記 */
  note?: string;
  /** 該日已知無資料，pill 用 dim 樣式 */
  dim?: boolean;
}

export interface DatePickerProps {
  value: string;
  onChange: (next: string) => void;
  /** 要顯示的日期列表（YYYY-MM-DD），最新在前。沒給就取「今日 + 過去 21 天」共 22 天 */
  dates?: string[];
  /** 每個日期的附加資訊（檔數 etc），key 是 YYYY-MM-DD */
  meta?: Record<string, DateMeta>;
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
  /** 顯示為 grid-cols-N 的欄位數，預設 11（對齊 ScanPanelVertical 設計）*/
  cols?: number;
  /** 最多顯示幾個 pill，預設 22 */
  limit?: number;
}

/**
 * 取最近 N 個工作日（含 anchor 當天，跳過六日；台股無交易日預設過濾）
 *
 * 為什麼跳週末：候選池 / MultiAgent / 掃描資料都只在交易日產生；
 * 顯示週末等於是死按鈕（點了沒資料），降低使用者誤觸。
 */
function lastNDays(n: number, anchor: string): string[] {
  const arr: string[] = [];
  const start = new Date(anchor + 'T00:00:00Z');
  let cursor = new Date(start);
  while (arr.length < n) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      arr.push(cursor.toISOString().slice(0, 10));
    }
    cursor = new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    // 安全防呆：避免 anchor 是異常字串時死循環
    if (arr.length === 0 && cursor < new Date('2000-01-01')) break;
  }
  return arr;
}

export function DatePicker({
  value,
  onChange,
  dates,
  meta,
  size = 'md',
  className,
  disabled,
  cols = 11,
  limit = 22,
}: DatePickerProps) {
  // 純 client-side 算 date 列表，避開 SSR/client `new Date()` hydration mismatch
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    // anchor 用 max(today, value) — 避免 value 落在過去（如 4/7）時整條 strip 跟著
    // 退到 4/7 而看不到 5 月新日期。value 在未來（罕見）才允許往後延。
    const todayYmd = new Date().toISOString().slice(0, 10);
    const anchor = dates && dates.length > 0
      ? undefined
      : (value && value > todayYmd ? value : todayYmd);
    const raw = dates && dates.length > 0
      ? [...dates]
      : lastNDays(limit, anchor as string);
    const dedup = raw
      .filter((d, i, arr) => arr.indexOf(d) === i)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, limit);
    // 若 value 落在 strip 外（如 value=4/7、strip 為 5/24-5/03），保留 value
    // 在最前面，user 可以清楚看到目前選的是 strip 外的日期
    if (value && !dedup.includes(value)) {
      dedup.unshift(value);
      if (dedup.length > limit) dedup.length = limit;
    }
    setList(dedup);
  }, [dates, value, limit]);

  const isMd = size === 'md';
  const pillBase = cn(
    'text-center rounded font-mono truncate transition-colors',
    isMd ? 'px-1 py-0.5 text-[10px]' : 'px-0.5 py-0.5 text-[9px]',
  );
  const pillActive = 'bg-sky-700 text-sky-100 font-semibold';
  const pillInactive = 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground';
  // dim: 已知該日無資料 — 用 strike-ish + 較暗底色
  const pillDim = 'bg-secondary/20 text-muted-foreground/40 hover:bg-secondary/40 hover:text-muted-foreground/60';

  const gridColsCls = cols === 11 ? 'grid-cols-11'
    : cols === 7 ? 'grid-cols-7'
    : cols === 14 ? 'grid-cols-14'
    : 'grid-cols-11';

  // 統一外觀：pill 寬度跟首頁右側「策略掃描」tab 一致（≈ 36-40px / pill）
  // md 限 480px、sm 由 tab 容器自然撐
  const maxWidth = isMd ? '480px' : undefined;

  return (
    <div
      className={cn('grid gap-1', gridColsCls, className)}
      style={maxWidth ? { maxWidth } : undefined}
    >
      {list.map((d) => {
        const isActive = d === value;
        const m = meta?.[d];
        const titleParts = [fmtDateLabelTw(d)];
        if (m?.count !== undefined) titleParts.push(`${m.count} ${m.unit ?? '檔'}`);
        if (m?.dim) titleParts.push('該日無資料');
        if (m?.note) titleParts.push(m.note);
        const variantCls = isActive ? pillActive : (m?.dim ? pillDim : pillInactive);
        return (
          <button
            key={d}
            type="button"
            disabled={disabled}
            onClick={() => onChange(d)}
            title={titleParts.join('｜')}
            className={cn(
              pillBase,
              variantCls,
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            {d.slice(5)}
          </button>
        );
      })}
    </div>
  );
}
