/**
 * 陸股紅旗資料採集 — 把 EastMoney 各 provider 結果正規化成 RedFlagInput。
 *
 * 重用既有 provider：
 *   fetchCnFinancials（淨利 YoY）、getEastMoneyFundamentals（TTM PE）、
 *   fetchCapitalFlow（主力資金）。
 * 新增輕量抓取（東財公告 / 研報，不同 host 用 fetchJsonWithCurlFallback）：
 *   質押公告（累計質押比 + 是否償還債務）、交易所異常波動公告、近半年券商研報數。
 *
 * **全部 best-effort**：每一塊獨立 try/catch，抓不到就留 null（不亮該旗、不誤報）。
 * 設計給 compose 在挑候選時逐檔呼叫，因此本模組不做併發、由呼叫端限速。
 */

import { fetchCnFinancials } from '@/lib/datasource/EastMoneyFinancials';
import { getEastMoneyFundamentals } from '@/lib/datasource/EastMoneyFundamentals';
import { fetchCapitalFlow } from '@/lib/datasource/EastMoneyCapitalFlow';
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';
import type { RedFlagInput } from './types';

/** 主力資金合計視窗（交易日） */
const MAIN_FLOW_WINDOW = 5;
/** 公告 / 異常波動回看天數 */
const ANN_LOOKBACK_DAYS = 14;
/** 研報視窗（天） */
const REPORT_WINDOW_DAYS = 180;

interface AnnItem {
  title: string;
  notice_date: string;
  art_code: string;
}

/** 6 位裸碼（去後綴） */
function bareCode(codeOrSymbol: string): string {
  return codeOrSymbol.replace(/\..*$/, '');
}

function daysAgoYmd(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ── 1) 業績 YoY（最新一期歸母淨利同比） ──────────────────────────────
async function getNetProfitYoY(code: string): Promise<number | null> {
  try {
    const qs = await fetchCnFinancials(code, 2);
    const latest = qs[0];
    return latest?.netProfitYoY ?? null;
  } catch {
    return null;
  }
}

// ── 2) TTM 本益比 ────────────────────────────────────────────────────
async function getPer(code: string): Promise<number | null> {
  try {
    const f = await getEastMoneyFundamentals(code);
    return f?.ttmPe ?? f?.staticPe ?? null;
  } catch {
    return null;
  }
}

// ── 3) 主力資金（近 N 日合計 + 連續流出天數） ─────────────────────────
async function getMainFlow(symbol: string): Promise<{ sum: number | null; consecOutflow: number | null }> {
  try {
    const days = await fetchCapitalFlow(symbol, MAIN_FLOW_WINDOW);
    if (days.length === 0) return { sum: null, consecOutflow: null };
    const asc = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const sum = asc.reduce((s, d) => s + (d.mainNet || 0), 0);
    let consec = 0;
    for (let i = asc.length - 1; i >= 0; i--) {
      if (asc[i].mainNet < 0) consec++;
      else break;
    }
    return { sum, consecOutflow: consec };
  } catch {
    return { sum: null, consecOutflow: null };
  }
}

// ── 4) 公告：質押（累計比 + 還債）+ 異常波動 ──────────────────────────
async function getAnnouncementFlags(code: string): Promise<{
  pledgeRatioPct: number | null;
  pledgeForRepayDebt: boolean | null;
  abnormalVolatilityRecent: boolean | null;
}> {
  const empty = { pledgeRatioPct: null, pledgeForRepayDebt: null, abnormalVolatilityRecent: null };
  try {
    const listUrl =
      `https://np-anotice-stock.eastmoney.com/api/security/ann` +
      `?sr=-1&page_size=20&page_index=1&ann_type=A&client_source=web&stock_list=${code}`;
    const res = await fetchJsonWithCurlFallback<{ data?: { list?: AnnItem[] } }>(listUrl, {
      timeoutMs: 12000,
    });
    const list = res.data?.data?.list ?? [];
    if (list.length === 0) return empty;

    const cutoff = daysAgoYmd(ANN_LOOKBACK_DAYS);
    const recent = list.filter((a) => (a.notice_date ?? '').slice(0, 10) >= cutoff);

    const abnormalVolatilityRecent = recent.some((a) => a.title?.includes('异常波动'));

    // 最近一筆質押公告 → 抓內容解析累計質押比 + 還債用途
    const pledgeAnn = recent.find((a) => a.title?.includes('质押'));
    let pledgeRatioPct: number | null = null;
    let pledgeForRepayDebt: boolean | null = null;
    if (pledgeAnn) {
      const { ratio, repay } = await parsePledgeContent(pledgeAnn.art_code);
      pledgeRatioPct = ratio;
      pledgeForRepayDebt = repay;
    }

    return { pledgeRatioPct, pledgeForRepayDebt, abnormalVolatilityRecent };
  } catch {
    return empty;
  }
}

/** 抓單則質押公告內容，正規表達式抽「累計質押佔其持股比例」+ 是否含「偿还债务」 */
async function parsePledgeContent(artCode: string): Promise<{ ratio: number | null; repay: boolean | null }> {
  try {
    const url =
      `https://np-cnotice-stock.eastmoney.com/api/content/ann` +
      `?art_code=${artCode}&client_source=web&page_index=1`;
    const res = await fetchJsonWithCurlFallback<{ data?: { notice_content?: string } }>(url, {
      timeoutMs: 12000,
    });
    const txt = res.data?.data?.notice_content ?? '';
    if (!txt) return { ratio: null, repay: null };

    // 「占其持股数量的比例为 65.05%」/「占其所持股份比例 65.05%」→ 取所有「占其…比例…%」最大值
    const ratios: number[] = [];
    const re = /占其[^%]{0,30}?([\d.]+)\s*%/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) ratios.push(v);
    }
    const ratio = ratios.length ? Math.max(...ratios) : null;
    // 「质押融资用途：偿还债务」常在表格內被排版拆開（偿还 / 债务 不相鄰），
    // 故用共現判定（質押公告內同時出現「偿还」+「债务/借款」= 還債用途）。
    const repay = /偿还/.test(txt) && /债务|借款/.test(txt);
    return { ratio, repay };
  } catch {
    return { ratio: null, repay: null };
  }
}

// ── 5) 近半年券商研報數 ──────────────────────────────────────────────
async function getReportCount(code: string): Promise<number | null> {
  try {
    const url =
      `https://reportapi.eastmoney.com/report/list?qType=0&code=${code}` +
      `&pageSize=50&pageNo=1&beginTime=${daysAgoYmd(REPORT_WINDOW_DAYS)}&endTime=${daysAgoYmd(0)}`;
    const res = await fetchJsonWithCurlFallback<{ hits?: number; data?: unknown[] }>(url, {
      timeoutMs: 12000,
      headers: { Referer: 'https://data.eastmoney.com/report/stock.jshtml' },
    });
    const hits = res.data?.hits;
    if (typeof hits === 'number') return hits;
    if (Array.isArray(res.data?.data)) return res.data.data.length;
    return null;
  } catch {
    return null;
  }
}

/**
 * 組單檔陸股的 RedFlagInput。逐檔順序抓（呼叫端負責限速 + 只抓 top N）。
 * @param codeOrSymbol 6 位碼或帶後綴（如 '600707' 或 '600707.SS'）
 */
export async function buildCnRedFlagInput(codeOrSymbol: string): Promise<RedFlagInput> {
  const code = bareCode(codeOrSymbol);
  // 後綴推 secid 用的 symbol（fetchCapitalFlow 吃帶後綴）；沒後綴時補 .SS/.SZ
  const symbol = /\./.test(codeOrSymbol)
    ? codeOrSymbol
    : `${code}.${code.startsWith('6') ? 'SS' : 'SZ'}`;

  const [netProfitYoYPct, per, mainFlow, ann, reportCount] = await Promise.all([
    getNetProfitYoY(code),
    getPer(code),
    getMainFlow(symbol),
    getAnnouncementFlags(code),
    getReportCount(code),
  ]);

  return {
    netProfitYoYPct,
    epsYoYPct: null, // CN 用淨利 YoY 為主，EPS YoY 暫不抓（避免重複算）
    per,
    mainNetRecentCny: mainFlow.sum,
    mainFlowWindowDays: MAIN_FLOW_WINDOW,
    mainNetConsecOutflowDays: mainFlow.consecOutflow,
    pledgeRatioPct: ann.pledgeRatioPct,
    pledgeForRepayDebt: ann.pledgeForRepayDebt,
    abnormalVolatilityRecent: ann.abnormalVolatilityRecent,
    analystReportCount: reportCount,
    analystReportWindowDays: REPORT_WINDOW_DAYS,
    themeStatus: null, // 題材落地度需 skill 語意層，compose 端另補
  };
}
