/**
 * 席位績效統計 — 每晚從 lhb/*.json 全量重建（P2）
 *
 * 設計決議：
 *   - **全量重建非增量**：增量更新在「fwd 欄事後回補」「檔案重抓」時會 drift，
 *     全量重建讀檔 + 純函式聚合，幾百個日檔在本地 FS 是秒級
 *   - **以 deptCode 為主鍵**：席位改名（券商合併潮，如 2025 国泰君安+海通）
 *     不斷檔；registry 只負責貼標（label/type），沒標也照常累積
 *   - 前瞻報酬直接用榜面自帶 fwd 欄（EM D1/D5/D10_CLOSE_ADJCHRATE，事後才填值，
 *     cn-agents-seats cron 會回補近 N 日）— 不另抓 K 線
 *   - 隔日砸盤率：買入後「次一個有檔交易日」出現在同股賣方 ÷ nBuy
 *     （用有檔日近似次一交易日 — 該股隔日沒上榜就視為沒砸，這是榜面可見性的
 *     固有限制，統計語意=「隔日砸到上榜程度」的比例）
 */

import type {
  LhbDailyFile,
  SeatRegistryFile,
  SeatStatsEntry,
  SeatStatsFile,
  SeatType,
} from './types';
import { CN_AGENTS_SCHEMA_VERSION } from './types';
import { lookupSeat } from './seats';

const RECENT_CAP = 8;
const TOP_INDUSTRIES_CAP = 3;

interface SeatEventRow {
  date: string;
  code: string;
  name: string;
  side: 'buy' | 'sell';
  netAmt: number | null;
  fwdD1: number | null;
  fwdD5: number | null;
  fwdD10: number | null;
  deptName: string;
}

const round3 = (x: number): number => +x.toFixed(3);

function avgOrNull(vals: Array<number | null>): number | null {
  const v = vals.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length > 0 ? round3(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

function winOrNull(vals: Array<number | null>): number | null {
  const v = vals.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length > 0 ? round3(v.filter((x) => x > 0).length / v.length) : null;
}

export function buildSeatStats(
  files: LhbDailyFile[],
  registry: SeatRegistryFile,
  industryBySymbol: Map<string, string>,
): SeatStatsFile {
  const sorted = [...files].sort((a, b) => a.date.localeCompare(b.date));
  const events = new Map<string, SeatEventRow[]>(); // deptCode → rows
  /** date → code → 賣方 deptCode 集合（隔日砸盤判定） */
  const sellersByDateCode = new Map<string, Map<string, Set<string>>>();

  for (const f of sorted) {
    const codeMap = new Map<string, Set<string>>();
    sellersByDateCode.set(f.date, codeMap);
    for (const s of f.stocks) {
      for (const side of ['buy', 'sell'] as const) {
        for (const t of s.seats[side]) {
          if (!t.deptCode) continue;
          const rows = events.get(t.deptCode) ?? [];
          rows.push({
            date: f.date,
            code: s.code,
            name: s.name,
            side,
            netAmt: t.netAmt,
            fwdD1: s.fwd.d1,
            fwdD5: s.fwd.d5,
            fwdD10: s.fwd.d10,
            deptName: t.deptName,
          });
          events.set(t.deptCode, rows);
          if (side === 'sell') {
            const sellers = codeMap.get(s.code) ?? new Set<string>();
            sellers.add(t.deptCode);
            codeMap.set(s.code, sellers);
          }
        }
      }
    }
  }

  const dates = sorted.map((f) => f.date);
  const nextDate = new Map<string, string | null>();
  for (let i = 0; i < dates.length; i++) nextDate.set(dates[i], dates[i + 1] ?? null);

  const seats: SeatStatsEntry[] = [];
  for (const [deptCode, rows] of events) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const latestName = rows[rows.length - 1].deptName;
    const tag = lookupSeat(deptCode, latestName, registry);

    const buys = rows.filter((r) => r.side === 'buy');
    const sells = rows.filter((r) => r.side === 'sell');

    let dumpCount = 0;
    let dumpEligible = 0;
    for (const b of buys) {
      const nd = nextDate.get(b.date);
      if (!nd) continue; // 視窗最後一日的買入無從判定
      dumpEligible++;
      if (sellersByDateCode.get(nd)?.get(b.code)?.has(deptCode)) dumpCount++;
    }

    const industryCount = new Map<string, number>();
    for (const r of rows) {
      const ind = industryBySymbol.get(r.code);
      if (!ind) continue;
      industryCount.set(ind, (industryCount.get(ind) ?? 0) + 1);
    }

    seats.push({
      deptCode,
      deptName: latestName,
      label: tag.label,
      type: tag.type as SeatType,
      nEvents: rows.length,
      nBuy: buys.length,
      nSell: sells.length,
      buyFwd: {
        avgD1: avgOrNull(buys.map((b) => b.fwdD1)),
        avgD5: avgOrNull(buys.map((b) => b.fwdD5)),
        avgD10: avgOrNull(buys.map((b) => b.fwdD10)),
        winD1: winOrNull(buys.map((b) => b.fwdD1)),
        winD5: winOrNull(buys.map((b) => b.fwdD5)),
      },
      nextDayDumpRate: dumpEligible > 0 ? round3(dumpCount / dumpEligible) : null,
      topIndustries: [...industryCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_INDUSTRIES_CAP)
        .map(([industry, n]) => ({ industry, n })),
      lastSeen: rows[rows.length - 1].date,
      recent: rows
        .slice(-RECENT_CAP)
        .reverse()
        .map((r) => ({ date: r.date, code: r.code, name: r.name, side: r.side, netAmt: r.netAmt, fwdD1: r.fwdD1 })),
    });
  }

  seats.sort((a, b) => b.nEvents - a.nEvents);
  return {
    schemaVersion: CN_AGENTS_SCHEMA_VERSION,
    builtAt: new Date().toISOString(),
    windowFrom: dates[0] ?? '',
    windowTo: dates[dates.length - 1] ?? '',
    seats,
  };
}
