/**
 * 批量回測腳本 — 朱老師六大條件策略驗證
 *
 * 用途：對多個歷史日期執行掃描 + 後續績效分析，驗證策略勝率
 * 執行：node scripts/batch-backtest.mjs
 *
 * 需先啟動 dev server：npm run dev
 */

const BASE = 'http://localhost:3001';

// ── Top 50 台股精選（流動性高，Yahoo Finance 資料完整）───────────────────────
const TW_STOCKS = [
  { symbol: '2330.TW', name: '台積電' },
  { symbol: '2454.TW', name: '聯發科' },
  { symbol: '2317.TW', name: '鴻海' },
  { symbol: '2382.TW', name: '廣達' },
  { symbol: '2308.TW', name: '台達電' },
  { symbol: '3711.TW', name: '日月光投控' },
  { symbol: '2303.TW', name: '聯電' },
  { symbol: '2891.TW', name: '中信金' },
  { symbol: '2882.TW', name: '國泰金' },
  { symbol: '2886.TW', name: '兆豐金' },
  { symbol: '2884.TW', name: '玉山金' },
  { symbol: '2881.TW', name: '富邦金' },
  { symbol: '2885.TW', name: '元大金' },
  { symbol: '2412.TW', name: '中華電' },
  { symbol: '2002.TW', name: '中鋼' },
  { symbol: '1303.TW', name: '南亞' },
  { symbol: '2912.TW', name: '統一超' },
  { symbol: '2603.TW', name: '長榮' },
  { symbol: '2609.TW', name: '陽明' },
  { symbol: '3008.TW', name: '大立光' },
  { symbol: '2357.TW', name: '華碩' },
  { symbol: '2376.TW', name: '技嘉' },
  { symbol: '2353.TW', name: '宏碁' },
  { symbol: '6669.TW', name: '緯穎' },
  { symbol: '4938.TW', name: '和碩' },
  { symbol: '2395.TW', name: '研華' },
  { symbol: '3034.TW', name: '聯詠' },
  { symbol: '2379.TW', name: '瑞昱' },
  { symbol: '6415.TW', name: '矽力' },
  { symbol: '3037.TW', name: '欣興' },
  { symbol: '2327.TW', name: '國巨' },
  { symbol: '2344.TW', name: '華邦電' },
  { symbol: '2408.TW', name: '南亞科' },
  { symbol: '3041.TW', name: '揚智科技' },
  { symbol: '2458.TW', name: '義隆電' },
  { symbol: '5274.TW', name: '信驊' },
  { symbol: '8046.TW', name: '南電' },
  { symbol: '2347.TW', name: '聯強' },
  { symbol: '2301.TW', name: '光寶科' },
  { symbol: '2615.TW', name: '萬海' },
  { symbol: '2618.TW', name: '長榮航' },
  { symbol: '2610.TW', name: '華航' },
  { symbol: '3045.TW', name: '台灣大' },
  { symbol: '4904.TW', name: '遠傳' },
  { symbol: '1301.TW', name: '台塑' },
  { symbol: '6505.TW', name: '台塑化' },
  { symbol: '2207.TW', name: '和泰車' },
  { symbol: '2912.TW', name: '統一超' },
  { symbol: '2105.TW', name: '正新' },
  { symbol: '9910.TW', name: '豐泰' },
];

// ── 測試日期：過去3年每週五（確保有足夠後續資料，共~70個交易日）────────────
// 選擇每月2-3個代表性日期，覆蓋不同市場環境
const TEST_DATES = [
  // 2023年（牛熊交替）
  '2023-01-13', '2023-01-27',
  '2023-02-10', '2023-02-24',
  '2023-03-10', '2023-03-24',
  '2023-04-14', '2023-04-28',
  '2023-05-12', '2023-05-26',
  '2023-06-09', '2023-06-23',
  '2023-07-14', '2023-07-28',
  '2023-08-11', '2023-08-25',
  '2023-09-08', '2023-09-22',
  '2023-10-13', '2023-10-27',
  '2023-11-10', '2023-11-24',
  '2023-12-08', '2023-12-22',
  // 2024年（大漲後修正）
  '2024-01-12', '2024-01-26',
  '2024-02-09', '2024-02-23',
  '2024-03-08', '2024-03-22',
  '2024-04-12', '2024-04-26',
  '2024-05-10', '2024-05-24',
  '2024-06-14', '2024-06-28',
  '2024-07-12', '2024-07-26',
  '2024-08-09', '2024-08-23',
  '2024-09-13', '2024-09-27',
  '2024-10-11', '2024-10-25',
  '2024-11-08', '2024-11-22',
  '2024-12-13', '2024-12-27',
  // 2025年（震盪）
  '2025-01-10', '2025-01-24',
  '2025-02-14', '2025-02-28',
  '2025-03-14', '2025-03-28',
  '2025-04-11', '2025-04-25',
  '2025-05-09', '2025-05-23',
  '2025-06-13', '2025-06-27',
  '2025-07-11', '2025-07-25',
  '2025-08-08', '2025-08-22',
  '2025-09-12', '2025-09-26',
  '2025-10-10', '2025-10-24',
  '2025-11-14', '2025-11-28',
  '2025-12-12', '2025-12-26',
  // 2026年初
  '2026-01-09', '2026-01-23',
  '2026-02-13',
];

// ── API helpers ──────────────────────────────────────────────────────────────

async function scanAtDate(date, stocks) {
  const half = Math.ceil(stocks.length / 2);
  const [r1, r2] = await Promise.allSettled([
    fetchChunk(date, stocks.slice(0, half)),
    fetchChunk(date, stocks.slice(half)),
  ]);
  const results = [
    ...(r1.status === 'fulfilled' ? r1.value.results : []),
    ...(r2.status === 'fulfilled' ? r2.value.results : []),
  ];
  const marketTrend =
    (r1.status === 'fulfilled' ? r1.value.marketTrend : null) ??
    (r2.status === 'fulfilled' ? r2.value.marketTrend : null) ?? '未知';
  return { results, marketTrend };
}

async function fetchChunk(date, stocks) {
  const res = await fetch(`${BASE}/api/backtest/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ market: 'TW', date, stocks }),
  });
  if (!res.ok) throw new Error(`scan ${res.status}`);
  return res.json();
}

async function fetchForward(scanDate, scanResults) {
  if (scanResults.length === 0) return [];
  const payload = scanResults.map(r => ({
    symbol: r.symbol, name: r.name, scanPrice: r.price,
  }));
  const res = await fetch(`${BASE}/api/backtest/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanDate, stocks: payload }),
  });
  if (!res.ok) throw new Error(`forward ${res.status}`);
  const json = await res.json();
  return json.performance ?? [];
}

// ── Result aggregation ───────────────────────────────────────────────────────

function summarize(allPerf) {
  const horizons = ['open', 'd1', 'd2', 'd3', 'd4', 'd5', 'd10', 'd20'];
  const labels   = { open:'隔日開', d1:'1日', d2:'2日', d3:'3日', d4:'4日', d5:'5日', d10:'10日', d20:'20日' };

  const result = {};
  for (const h of horizons) {
    const key = `${h}Return`;
    const values = allPerf
      .map(p => p[key])
      .filter(v => v != null && isFinite(v));
    if (values.length === 0) { result[h] = null; continue; }
    const wins = values.filter(v => v > 0).length;
    const avg  = values.reduce((a, b) => a + b, 0) / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const mid  = sorted[Math.floor(sorted.length / 2)];
    result[h] = {
      label:   labels[h],
      n:       values.length,
      winRate: Math.round(wins / values.length * 100),
      avg:     +avg.toFixed(2),
      median:  +mid.toFixed(2),
      maxGain: +Math.max(...values).toFixed(2),
      maxLoss: +Math.min(...values).toFixed(2),
    };
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍 朱老師六大條件策略 — 批量回測報告');
  console.log('='.repeat(60));
  console.log(`📅 測試日期: ${TEST_DATES.length} 個`);
  console.log(`📊 股票池: ${TW_STOCKS.length} 檔台股`);
  console.log(`🌐 Server: ${BASE}`);
  console.log('');

  const allPerformance = [];
  const dateResults = [];
  let totalHits = 0;
  const trendCounts = { '多頭': 0, '空頭': 0, '盤整': 0, '未知': 0 };

  for (let i = 0; i < TEST_DATES.length; i++) {
    const date = TEST_DATES[i];
    process.stdout.write(`[${String(i+1).padStart(2)}/${TEST_DATES.length}] ${date} 掃描中...`);

    try {
      const t0 = Date.now();
      const { results, marketTrend } = await scanAtDate(date, TW_STOCKS);
      trendCounts[marketTrend] = (trendCounts[marketTrend] ?? 0) + 1;

      if (results.length === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(` 無符合股票 (大盤${marketTrend}) [${elapsed}s]`);
        dateResults.push({ date, hits: 0, marketTrend, avgD5: null });
        continue;
      }

      const perf = await fetchForward(date, results);
      allPerformance.push(...perf);
      totalHits += results.length;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      // Quick d5 summary for this date
      const d5s = perf.map(p => p.d5Return).filter(v => v != null && isFinite(v));
      const d5wins = d5s.filter(v => v > 0).length;
      const d5avg  = d5s.length > 0 ? (d5s.reduce((a,b)=>a+b,0)/d5s.length).toFixed(2) : null;
      const d5wr   = d5s.length > 0 ? Math.round(d5wins/d5s.length*100) : null;

      console.log(
        ` ✓ ${results.length}檔 大盤${marketTrend} 5日勝率${d5wr ?? '--'}% avg${d5avg ?? '--'}% [${elapsed}s]`
      );
      dateResults.push({ date, hits: results.length, marketTrend, avgD5: d5avg, d5wr });

    } catch (err) {
      console.log(` ❌ 錯誤: ${err.message}`);
      dateResults.push({ date, hits: 0, marketTrend: '未知', error: err.message });
    }
  }

  // ── Final Report ─────────────────────────────────────────────────────────
  console.log('');
  console.log('='.repeat(60));
  console.log('📊 整體績效報告');
  console.log('='.repeat(60));
  console.log(`總選出股票數: ${totalHits} 檔 / ${TEST_DATES.length} 個交易日`);
  console.log(`有效績效數據: ${allPerformance.length} 筆`);
  console.log(`大盤趨勢分佈: 多頭${trendCounts['多頭']}次 盤整${trendCounts['盤整']}次 空頭${trendCounts['空頭']}次`);
  console.log('');

  const summary = summarize(allPerformance);
  console.log('各持有天數報告:');
  console.log('-'.repeat(60));
  console.log(
    '指標       '.padEnd(10) +
    '隔日開'.padStart(8) + '1日'.padStart(8) + '2日'.padStart(8) + '3日'.padStart(8) +
    '4日'.padStart(8) + '5日'.padStart(8) + '10日'.padStart(8) + '20日'.padStart(8)
  );
  console.log('-'.repeat(60));

  const horizons = ['open', 'd1', 'd2', 'd3', 'd4', 'd5', 'd10', 'd20'];

  ['winRate', 'avg', 'median', 'maxGain', 'maxLoss', 'n'].forEach(metric => {
    const labels = { winRate:'勝率%', avg:'平均%', median:'中位%', maxGain:'最高%', maxLoss:'最低%', n:'樣本數' };
    const row = labels[metric].padEnd(10);
    const vals = horizons.map(h => {
      if (!summary[h]) return '   --';
      const v = summary[h][metric];
      if (v === null || v === undefined) return '   --';
      const str = metric === 'n' ? String(v) : (v > 0 && metric !== 'n' ? '+' : '') + v;
      return str.padStart(8);
    }).join('');
    console.log(row + vals);
  });

  console.log('');
  console.log('='.repeat(60));
  console.log('📅 各日期明細:');
  console.log('-'.repeat(60));
  dateResults.forEach(d => {
    const trend = (d.marketTrend || '未知').padEnd(4);
    const hits  = String(d.hits).padStart(3);
    const d5    = d.d5wr != null ? `${d.d5wr}%勝率 avg${d.avgD5}%` : '無資料';
    console.log(`${d.date}  大盤${trend}  ${hits}檔  5日:${d5}`);
  });

  console.log('');
  console.log('✅ 報告完成');
}

main().catch(console.error);
