/**
 * audit-cn-financials-monotonic.ts — 陸股逐季財報（RPT_LICO_FN_CPD）健全性 audit
 *
 * 目的：判斷「五粮液 2025 淨利異常」是 EastMoney 結構性 bug（單季誤當累計）還是個股真實/披露值。
 *
 * 對每檔抓 fetchCnFinancials，依會計年度分組，檢查：
 *   A. 累計單調性 —— 同一年 Q1≤H1≤9M≤FY？（累計淨利正常應非遞減；遞減＝有虧損季 or 結構異常）
 *   B. 最近完整年度 FY 淨利 YoY（vs 前一年 FY）
 *   C. 單季崩塌 —— 某單季淨利 < 該年平均單季的 15%（潛在一次性事件 or 數據異常）
 *
 * 用法：npx tsx scripts/audit-cn-financials-monotonic.ts
 */

import { fetchCnFinancials, type FinancialQuarter } from '@/lib/datasource/EastMoneyFinancials';

const UNIVERSE: Array<[string, string]> = [
  // 白酒
  ['600519', '贵州茅台'], ['000858', '五粮液'], ['000568', '泸州老窖'], ['600809', '山西汾酒'],
  ['002304', '洋河股份'], ['000596', '古井贡酒'], ['603369', '今世缘'], ['000799', '酒鬼酒'],
  ['600559', '老白干酒'], ['603198', '迎驾贡酒'],
  // 银行/保险
  ['000001', '平安银行'], ['600036', '招商银行'], ['601398', '工商银行'], ['601318', '中国平安'],
  // 科技/制造
  ['002594', '比亚迪'], ['300750', '宁德时代'], ['000333', '美的集团'], ['600276', '恒瑞医药'],
  ['002415', '海康威视'], ['600900', '长江电力'], ['601899', '紫金矿业'],
  // 消费
  ['600887', '伊利股份'], ['000651', '格力电器'], ['603288', '海天味业'], ['600031', '三一重工'],
];

const yi = (n: number | null) => (n == null ? '   —  ' : `${(n / 1e8).toFixed(0)}億`.padStart(6));

function groupByYear(fins: FinancialQuarter[]): Map<number, Record<string, number | null>> {
  const m = new Map<number, Record<string, number | null>>();
  for (const f of fins) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.reportDate)) continue;
    const yr = parseInt(f.reportDate.slice(0, 4), 10);
    const mmdd = f.reportDate.slice(5);
    if (!m.has(yr)) m.set(yr, {});
    m.get(yr)![mmdd] = f.netProfit;
  }
  return m;
}

function isMonotonic(q: Record<string, number | null>): { mono: boolean; detail: string } {
  const order = ['03-31', '06-30', '09-30', '12-31'];
  const vals = order.map((k) => q[k]).filter((v): v is number => v != null);
  let mono = true;
  for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1] - 1) mono = false; // 容忍 1 元浮動
  return { mono, detail: vals.map((v) => (v / 1e8).toFixed(0)).join('→') };
}

(async () => {
  console.log('代碼     名稱        最近FY     FY-1     FY YoY   單調?  異常季(單季<15%均)');
  console.log('─'.repeat(92));
  const flagged: string[] = [];

  for (const [code, name] of UNIVERSE) {
    let fins: FinancialQuarter[];
    try {
      fins = await fetchCnFinancials(code, 12);
    } catch (e) {
      console.log(`${code}  ${name.padEnd(8)}  抓取失敗 ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const years = groupByYear(fins);
    const annuals = [...years.entries()]
      .filter(([, q]) => q['12-31'] != null)
      .sort((a, b) => b[0] - a[0]); // 新→舊
    if (annuals.length < 2) { console.log(`${code}  ${name.padEnd(8)}  年報資料不足`); continue; }

    const [lyYear, lyQ] = annuals[0];
    const [pyYear, pyQ] = annuals[1];
    const fy = lyQ['12-31']!;
    const fyPrev = pyQ['12-31']!;
    const yoy = fyPrev !== 0 ? ((fy - fyPrev) / Math.abs(fyPrev)) * 100 : null;

    // 單調性（看最近完整年度）
    const { mono, detail } = isMonotonic(lyQ);

    // 單季崩塌偵測（最近完整年度）
    const order = ['03-31', '06-30', '09-30', '12-31'];
    const cum = order.map((k) => lyQ[k]);
    const singles: number[] = [];
    let prev = 0;
    for (const c of cum) { if (c == null) { singles.push(NaN); } else { singles.push(c - prev); prev = c; } }
    const validSingles = singles.filter((s) => !Number.isNaN(s));
    const avg = validSingles.reduce((a, b) => a + b, 0) / (validSingles.length || 1);
    const collapseIdx = singles.findIndex((s) => !Number.isNaN(s) && avg > 0 && s < avg * 0.15);
    const collapse = collapseIdx >= 0 ? `Q${collapseIdx + 1}=${(singles[collapseIdx] / 1e8).toFixed(1)}億` : '';

    const yoyStr = yoy == null ? '  —  ' : `${yoy >= 0 ? '+' : ''}${yoy.toFixed(0)}%`.padStart(6);
    const monoStr = mono ? '單調' : '⚠非單調';
    const extreme = yoy != null && yoy < -40;
    const mark = (extreme || !mono || collapse) ? ' ◀' : '';
    console.log(
      `${code}  ${name.padEnd(8)}  ${yi(fy)}(${lyYear}) ${yi(fyPrev)}(${pyYear}) ${yoyStr}  ${monoStr.padEnd(7)} ${collapse}${mark}`,
    );
    if (extreme || !mono || collapse) flagged.push(`${name}(${code}): FY YoY ${yoyStr.trim()}, ${mono ? '單調' : '非單調'}, 序列 ${detail}${collapse ? ', ' + collapse : ''}`);
  }

  console.log('\n=== 旗標（FY YoY<-40% 或 非單調 或 單季崩塌）===');
  if (flagged.length === 0) console.log('（無）');
  else flagged.forEach((f) => console.log('  ⚠ ' + f));
  console.log(`\n總計 ${UNIVERSE.length} 檔，旗標 ${flagged.length} 檔。`);
  console.log('判讀：非單調=結構可疑（單季誤當累計會非單調）；單調但YoY極端=真實/披露值（換源也一樣）。');
})();
