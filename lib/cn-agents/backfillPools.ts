/**
 * 陸股漲停池「日K 重建」路徑（cn-agents P1 歷史回填硬牆解法）
 *
 * 背景：EastMoney push2ex 漲停池的 date 參數只保留 ~8 個交易日
 * （2026-06-12 實測：2026-06-01 有資料、2026-05-20 起全空；akshare 同源
 * 同窗口已驗證）。更舊的歷史只能從日K 序列重建每日漲停 / 炸板 / 跌停池。
 *
 * 純函式、零 IO：日K 由 caller 透過 loadSeries callback 餵入（主板讀 L1、
 * 創業/科創讀 EM klines 快取），方便單元測試直餵 fixture。
 *
 * ── 漲停判定：A 股「精確」規則（刻意不用 lib/utils/limitRules）─────────────
 * 交易所漲停價公式 = round(昨收 ×(1+幅度), 2位小數)（四捨五入到分）：
 *   limitPrice = Math.round(prevClose × (1 + pct) × 100) / 100
 *   close ≥ limitPrice − 1e-9 → 封住（1e-9 只吸收浮點誤差，不是 tick 容忍）
 * lib/utils/limitRules 的 isLimitUp 用 gtOrEqWithTick（整個 tick 的容忍帶，
 * 給「接近漲停」的掃描語意用）— 重建池子要的是「精確封板」，差一分錢就不是
 * 漲停，故自寫精確版。
 *
 * 幅度規則（板別優先於 ST — 創業板/科創板註冊制後 ST 股漲跌幅仍為 20%，
 * 只有主板 ST 才是 5%）：
 *   ChiNext / STAR → 0.20；主板 isST → 0.05；主板其餘 → 0.10
 *
 * ── 已知 proxy / 限制（重建拿不到盤中資訊，types 對應欄位都是 nullable）──
 *   - sealAmountCny / firstSealTime / lastSealTime / brokenTimes /
 *     floatMvCny / turnoverCny / boardsPattern → null
 *   - isOneWord proxy：open===high===low===close 且漲停（真一字；EM 路徑的
 *     「09:25 封板全日未開」準一字抓不到，重建版偏嚴）
 *   - isST 用「當前」名字判歷史（ST 帽子有摘戴史，歷史當下是否 ST 無從查，
 *     proxy 誤差集中在摘帽/戴帽前後的個股）
 *   - 前復權價（與 L1 一致）在除權息日附近做 0.01 進位判定會有微小誤差
 *     （調整因子縮放後非實際成交價），僅影響除權息當日附近少數標的
 *   - 北交所（4/8/92 開頭）不在 universe：30% 幅度、L1 沒有日K，刻意排除
 *     （與 EM 路徑統計口徑差異極小，北交所漲停家數本來就少）
 *   - 停牌跳日：series 內相鄰兩根即視為「連續交易日」（該股自身的相鄰），
 *     連板計數與次日報酬歸屬都按此規則 — 停牌復牌後的次根自然接上
 */

import { classifyCnBoard, isStName } from './cnBoard';
import type { BrokenEntry, LimitDownEntry, LimitUpEntry } from './types';

// ── 對外型別 ──────────────────────────────────────────────────────────────────

export interface BackfillSymbolMeta {
  /** 完整代號（'000725.SZ' / '688001.SS'）或 6 位裸碼皆可，內部統一剝成裸碼 */
  symbol: string;
  name: string;
  industry: string | null;
}

export interface BackfillSeriesBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ReconstructedDay {
  limitUp: LimitUpEntry[];
  broken: BrokenEntry[];
  limitDown: LimitDownEntry[];
  /** 全 universe 漲跌平家數（close vs prevClose） */
  overview: { upCount: number; downCount: number; flatCount: number };
  /** 「昨日漲停股」今日逐檔漲跌 %（caller 取平均 = 接力賺錢效應） */
  yestLimitUpReturns: number[];
  /** 「昨日炸板股」今日逐檔漲跌 %（虧錢效應） */
  yestBrokenReturns: number[];
}

// ── 精確漲跌停價 ──────────────────────────────────────────────────────────────

/** 板別 + 主板 ST → 漲跌停幅度（見檔頭：板別優先於 ST） */
function limitPctOf(board: ReturnType<typeof classifyCnBoard>, isST: boolean): number {
  if (board === 'ChiNext' || board === 'STAR') return 0.2;
  if (isST) return 0.05;
  return 0.1;
}

/** 交易所精確漲停價：round(prevClose×(1+pct), 2) */
export function exactLimitUpPrice(prevClose: number, pct: number): number {
  return Math.round(prevClose * (1 + pct) * 100) / 100;
}

/** 交易所精確跌停價（對稱）：round(prevClose×(1−pct), 2) */
export function exactLimitDownPrice(prevClose: number, pct: number): number {
  return Math.round(prevClose * (1 - pct) * 100) / 100;
}

const EPS = 1e-9;

// ── 主函式 ────────────────────────────────────────────────────────────────────

/**
 * 從日K 序列重建 [from, to] 每日池子。
 *
 * 逐 symbol 走一遍完整序列（O(symbols×bars)，單檔讀完即丟、省記憶體）：
 *   - 每日判 limitUp / broken（high 觸停且 close 未封）/ limitDown（對稱）
 *   - consecBoards：連續漲停日計數（從序列頭開始累計，from 之前的連板
 *     歷史自然帶入，首板=1）；跌停同理（consecDownBoards）
 *   - 漲停日 i 的次一根 series[i+1] 漲跌 % 累進 yestLimitUpReturns[次根日]
 *     （= 該日的「昨日漲停股今日表現」；停牌跳日由「該股自身次根」自然處理）
 *   - upCount/downCount/flatCount：全 universe close vs prevClose
 *
 * loadSeries 回 null / 空陣列 / 單根（無 prevClose）的 symbol 自動跳過。
 * series 必須按 date 升冪（L1 與 EM klines 都是）；亂序輸入不防呆。
 */
export function reconstructPools(args: {
  metas: BackfillSymbolMeta[];
  loadSeries: (symbol: string) => BackfillSeriesBar[] | null;
  from: string;
  to: string;
}): Map<string, ReconstructedDay> {
  const { metas, loadSeries, from, to } = args;
  const out = new Map<string, ReconstructedDay>();

  const dayOf = (date: string): ReconstructedDay => {
    let d = out.get(date);
    if (!d) {
      d = {
        limitUp: [],
        broken: [],
        limitDown: [],
        overview: { upCount: 0, downCount: 0, flatCount: 0 },
        yestLimitUpReturns: [],
        yestBrokenReturns: [],
      };
      out.set(date, d);
    }
    return d;
  };

  for (const meta of metas) {
    const series = loadSeries(meta.symbol);
    if (!series || series.length < 2) continue;

    // 裸碼（'000725.SZ' → '000725'）；EM 偶有前導零被吃 → padStart 防呆
    const bare = meta.symbol.split('.')[0].padStart(6, '0');
    const board = classifyCnBoard(bare);
    const isST = isStName(meta.name);
    const pct = limitPctOf(board, isST);

    let consecUp = 0; // 截至前一根的連續漲停日數
    let consecDown = 0;

    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1];
      const bar = series[i];
      const inRange = bar.date >= from && bar.date <= to;

      // 防呆：壞 bar（非正數價格）跳過該日判定並重置連續計數
      if (
        !Number.isFinite(prev.close) || prev.close <= 0 ||
        !Number.isFinite(bar.close) || bar.close <= 0
      ) {
        consecUp = 0;
        consecDown = 0;
        continue;
      }

      const limitUpPx = exactLimitUpPrice(prev.close, pct);
      const limitDownPx = exactLimitDownPrice(prev.close, pct);
      const dayPct = (bar.close / prev.close - 1) * 100;

      const sealedUp = bar.close >= limitUpPx - EPS;
      const touchedUp = bar.high >= limitUpPx - EPS;
      const sealedDown = bar.close <= limitDownPx + EPS;

      // 次日報酬歸屬：前一根（i-1）是漲停/炸板 → 今根 dayPct 累進「今根日期」
      // 只在今根日期落在 [from, to] 時記（前一根可早於 from — 跨界自然接上）。
      // ST 排除：與 computeBrokenAvgPctFromQuotes 的 isST 過濾對齊（ST 5% 波動
      // 帶會稀釋接力賺錢/虧錢效應訊號）
      if (inRange && i >= 2 && !isST) {
        const prev2 = series[i - 2];
        if (Number.isFinite(prev2.close) && prev2.close > 0) {
          const prevLimitUpPx = exactLimitUpPrice(prev2.close, pct);
          const prevSealedUp = prev.close >= prevLimitUpPx - EPS;
          const prevTouchedUp = prev.high >= prevLimitUpPx - EPS;
          if (prevSealedUp) dayOf(bar.date).yestLimitUpReturns.push(dayPct);
          else if (prevTouchedUp) dayOf(bar.date).yestBrokenReturns.push(dayPct);
        }
      }

      // 連續計數先算「今根」的值（含今根）
      const consecUpToday = sealedUp ? consecUp + 1 : 0;
      const consecDownToday = sealedDown ? consecDown + 1 : 0;

      if (inRange) {
        const day = dayOf(bar.date);

        // 漲跌平家數（全 universe）
        if (dayPct > EPS) day.overview.upCount += 1;
        else if (dayPct < -EPS) day.overview.downCount += 1;
        else day.overview.flatCount += 1;

        if (sealedUp) {
          day.limitUp.push({
            symbol: bare,
            name: meta.name,
            board,
            pct: dayPct,
            close: bar.close,
            turnoverCny: null,
            floatMvCny: null,
            sealAmountCny: null,
            firstSealTime: null,
            lastSealTime: null,
            brokenTimes: null,
            consecBoards: consecUpToday,
            boardsPattern: null,
            industry: meta.industry,
            // 一字板 proxy：四價同值且漲停（真一字；準一字抓不到，見檔頭）
            isOneWord:
              bar.open === bar.high && bar.high === bar.low && bar.low === bar.close,
            isST,
          });
        } else if (touchedUp) {
          // 炸板：盤中觸停（high ≥ 漲停價）但收盤未封
          day.broken.push({
            symbol: bare,
            name: meta.name,
            board,
            pct: dayPct,
            close: bar.close,
            brokenTimes: null,
            firstSealTime: null,
            industry: meta.industry,
            isST,
          });
        }

        if (sealedDown) {
          day.limitDown.push({
            symbol: bare,
            name: meta.name,
            board,
            pct: dayPct,
            close: bar.close,
            consecDownBoards: consecDownToday,
            industry: meta.industry,
            isST,
          });
        }
      }

      consecUp = consecUpToday;
      consecDown = consecDownToday;
    }
  }

  return out;
}
