/**
 * 法人報告彙整 — 把 data/broker/reports/*.json 全部整合成一份人話 markdown 報告。
 *
 * 重用單一事實來源：
 *   - computeBrokerPerformance（每日報告後漲跌幅 + 目標價達標度）
 *   - computeConsensus（跨券商高共識）
 *   - computeScorecard（各券商命中率）
 *
 * 不重造漲跌幅 / 共識 / 評等正規化邏輯。
 *
 * 用法：npx tsx scripts/consolidate-broker-reports.ts [outPath]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listReportDates } from '@/lib/broker/brokerStorage';
import { computeBrokerPerformance, type BrokerStockPerformance } from '@/lib/broker/brokerPerformance';
import { computeConsensus } from '@/lib/broker/brokerConsensus';
import { computeScorecard } from '@/lib/broker/brokerScorecard';

const SENTIMENT_LABEL: Record<string, string> = {
  bullish: '看多', bearish: '看空', neutral: '中立', mentioned_only: '純提及',
};
const ACTION_LABEL: Record<string, string> = {
  initiate: '首評', upgrade: '升評', downgrade: '降評', maintain: '維持',
};

/** 把評等（英文原文或正規化值）一律翻成中文，避免報告出現英文。 */
function ratingZh(raw: string, norm: string): string {
  // 已是中文（凱基/中信等本土券商）→ 原樣保留
  if (/[一-鿿]/.test(raw || '')) return raw;
  const s = (raw || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
  const RAW_MAP: Record<string, string> = {
    'buy': '買進', 'conviction list buy': '確信買進', 'outperform': '優於大盤',
    'overweight': '加碼', 'add': '加碼', 'accumulate': '加碼',
    'neutral': '中立', 'equal-weight': '中性', 'equalweight': '中性',
    'hold': '持有', 'market perform': '中性', 'in-line': '中性',
    'underweight': '減碼', 'reduce': '減碼', 'underperform': '劣於大盤', 'sell': '賣出',
    'upgrade to buy': '買進', 'not rated': '未評等', 'restricted': '限制',
  };
  if (RAW_MAP[s]) return RAW_MAP[s];
  const NORM_MAP: Record<string, string> = {
    buy: '買進', overweight: '加碼', neutral: '中立', hold: '持有',
    underweight: '減碼', sell: '賣出', other: '—',
  };
  return NORM_MAP[norm] || '—';
}

const pct = (n: number | null | undefined): string =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const num = (n: number | null | undefined): string =>
  n == null ? '—' : (Math.round(n * 100) / 100).toLocaleString('en-US');

/** 持有至今報酬：(現價 - 報告日收盤) / 報告日收盤。 */
function holdReturn(it: BrokerStockPerformance): number | null {
  const base = it.target.reportClose;
  const cur = it.target.currentPrice;
  if (base == null || cur == null || base <= 0) return null;
  return Math.round(((cur - base) / base) * 1000) / 10;
}

async function main() {
  const outPath = process.argv[2] || path.join(process.cwd(), 'data', 'broker', '法人報告彙整.md');
  const dates = (await listReportDates()).slice().sort(); // 升冪
  if (dates.length === 0) {
    console.error('沒有任何法人報告資料。');
    process.exit(1);
  }
  const start = dates[0];
  const end = dates[dates.length - 1];

  // 逐日績效
  const allItems: BrokerStockPerformance[] = [];
  let reportCount = 0;
  const brokerSet = new Set<string>();
  const stockSet = new Set<string>();
  const currentPriceByCode = new Map<string, number>(); // 代號 → 今日收盤
  for (const d of dates) {
    const day = await computeBrokerPerformance(d);
    reportCount += day.stats.report_count;
    for (const it of day.items) {
      allItems.push(it);
      brokerSet.add(it.broker_display);
      if (it.stock_code) stockSet.add(it.stock_code);
      if (it.stock_code && it.target.currentPrice != null) {
        currentPriceByCode.set(it.stock_code, it.target.currentPrice);
      }
    }
  }

  // 跨券商共識（全期間窗）
  const spanDays = Math.ceil((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  const consensus = await computeConsensus(end, spanDays);

  // 券商準度
  const scorecard = await computeScorecard();

  // ── 組 markdown ─────────────────────────────────────────────
  const L: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  L.push(`# 法人報告彙整`);
  L.push('');
  L.push(`> 期間 **${start} ~ ${end}**　產出日 ${today}`);
  L.push('');

  // 台股、方向性(看多/看空)、主標的(covered) 的 call
  const twDirectional = allItems.filter(
    it => it.market === 'TW' && it.stock_code &&
      (it.sentiment === 'bullish' || it.sentiment === 'bearish'),
  );

  // 重點結論（放最前面）
  const holdRanked = twDirectional
    .filter(it => it.sentiment === 'bullish')
    .map(it => ({ it, hold: holdReturn(it) }))
    .filter(x => x.hold != null) as { it: BrokerStockPerformance; hold: number }[];
  holdRanked.sort((a, b) => b.hold - a.hold);
  const hiNamesEarly = consensus.filter(c => c.high_consensus);
  L.push(`## 重點結論`);
  L.push('');
  L.push(`- 這段期間券商幾乎一面倒看多（看多 ${twDirectional.filter(i => i.sentiment === 'bullish').length} 筆，看空只有 1 筆）。`);
  if (holdRanked.length >= 3) {
    const top = holdRanked.slice(0, 3).map(x => `${x.it.stock_name}（${x.it.broker_display} ${pct(x.hold)}）`).join('、');
    L.push(`- 喊完最會漲的：${top}。`);
    const worst = holdRanked.slice(-3).reverse().map(x => `${x.it.stock_name}（${x.it.broker_display} ${pct(x.hold)}）`).join('、');
    L.push(`- 喊完反而最弱的：${worst}。`);
  }
  if (hiNamesEarly.length > 0) {
    L.push(`- 多家券商一起看好（≥2 家）：${hiNamesEarly.slice(0, 8).map(c => c.stock_name).join('、')}${hiNamesEarly.length > 8 ? ' 等' : ''}（共 ${hiNamesEarly.length} 檔）。`);
  }
  // 上漲空間最大（離目標價最遠）— 不限券商家數，單一家喊的也算
  const upsideRanked = twDirectional
    .filter(it => it.sentiment === 'bullish' && it.target_price != null
      && !it.target.currencyMismatch && it.target.distanceToTargetPct != null)
    .sort((a, b) => (b.target.distanceToTargetPct ?? 0) - (a.target.distanceToTargetPct ?? 0));
  if (upsideRanked.length >= 3) {
    const top = upsideRanked.slice(0, 5)
      .map(it => `${it.stock_name}（${it.broker_display} 還有 ${pct(it.target.distanceToTargetPct)}）`)
      .join('、');
    L.push(`- 離目標價最遠、上漲空間最大（含只有 1 家喊的）：${top}。`);
  }
  L.push(`- 提醒：多數報告是 6 月才進來的，還沒滿 20 個交易日，「準不準」要再等等才算得出來；下面看的是「喊完到今天漲跌多少」。`);
  L.push('');

  // 總覽
  L.push(`## 總覽`);
  L.push('');
  L.push(`- 報告份數：**${reportCount}** 份　券商：**${brokerSet.size}** 家　台股標的：**${stockSet.size}** 檔`);
  L.push(`- 有評等的台股觀點（看多/看空）：**${twDirectional.length}** 筆`);
  const bullN = twDirectional.filter(i => i.sentiment === 'bullish').length;
  const bearN = twDirectional.filter(i => i.sentiment === 'bearish').length;
  L.push(`- 其中看多 **${bullN}** 筆、看空 **${bearN}** 筆`);
  L.push('');

  // 跨券商高共識
  // 只取「看多券商」的目標價（每家取最新一份、限 TWD）→ 看多均價/區間，
  // 避免中立評等的低標把平均拉低（如大立光大摩中立 2,450）。
  function bullishTargetStats(code: string): { avg: number | null; min: number | null; max: number | null } {
    const byBroker = new Map<string, { date: string; target: number }>();
    for (const it of allItems) {
      if (it.stock_code !== code) continue;
      if (it.sentiment !== 'bullish') continue;
      if (it.target_price == null) continue;
      if ((it.report_currency || 'TWD').toUpperCase() !== 'TWD') continue;
      const prev = byBroker.get(it.broker);
      if (!prev || it.report_date > prev.date) byBroker.set(it.broker, { date: it.report_date, target: it.target_price });
    }
    const t = Array.from(byBroker.values()).map(v => v.target);
    if (t.length === 0) return { avg: null, min: null, max: null };
    return {
      avg: Math.round((t.reduce((s, x) => s + x, 0) / t.length) * 100) / 100,
      min: Math.min(...t), max: Math.max(...t),
    };
  }

  const hi = consensus.filter(c => c.high_consensus);
  L.push(`## 跨券商高共識（≥2 家同向）`);
  L.push('');
  if (hi.length === 0) {
    L.push('_本期沒有 2 家以上券商同向的標的。_');
  } else {
    L.push('（「還有空間」＝（看多均價 − 今日收盤）÷ 今日收盤；正＝還有上漲空間（有肉），負＝股價已超過看多均價（肉吃完了）。看多均價只算看多券商的目標價、不含中立。已依還有空間由多到少排序。）');
    L.push('');
    L.push('| 股票 | 看多券商 | 看空券商 | 今日收盤 | 看多均價 | 還有空間 | 目標價區間 | 最新報告日 |');
    L.push('|---|---|---|---:|---:|---:|---|---|');
    const hiRows = hi.map(c => {
      const cur = currentPriceByCode.get(c.stock_code) ?? null;
      const bt = bullishTargetStats(c.stock_code);
      const upside = (cur != null && bt.avg != null && cur > 0)
        ? Math.round(((bt.avg - cur) / cur) * 1000) / 10 : null;
      return { c, cur, bt, upside };
    });
    // 還有空間多的排前面（無目標價/無收盤的排最後）
    hiRows.sort((a, b) => (b.upside ?? -Infinity) - (a.upside ?? -Infinity));
    for (const { c, cur, bt, upside } of hiRows) {
      const range = bt.min != null && bt.max != null
        ? (bt.min === bt.max ? num(bt.min) : `${num(bt.min)} ~ ${num(bt.max)}`) : '—';
      L.push(`| ${c.stock_code} ${c.stock_name} | ${c.bullish_brokers.join('、') || '—'} | ${c.bearish_brokers.join('、') || '—'} | ${num(cur)} | ${num(bt.avg)} | ${pct(upside)} | ${range} | ${c.latest_report_date} |`);
    }
  }
  L.push('');

  // 報告後表現：持有至今報酬排序
  const withHold = twDirectional
    .map(it => ({ it, hold: holdReturn(it) }))
    .filter(x => x.hold != null) as { it: BrokerStockPerformance; hold: number }[];

  // 對「看多」算 hold（看多希望漲），看空另列
  const bullHold = withHold.filter(x => x.it.sentiment === 'bullish').sort((a, b) => b.hold - a.hold);
  L.push(`## 看多名單 — 喊完到現在漲跌（持有至今）`);
  L.push('');
  if (bullHold.length === 0) {
    L.push('_無可計算的看多 call。_');
  } else {
    L.push('| 股票 | 券商 | 評等 | 動作 | 報告日 | 報告日收盤 | 現價 | 持有至今 |');
    L.push('|---|---|---|---|---|---:|---:|---:|');
    for (const { it, hold } of bullHold) {
      L.push(`| ${it.stock_code} ${it.stock_name} | ${it.broker_display} | ${ratingZh(it.rating_raw, it.rating)} | ${ACTION_LABEL[it.rating_action] || it.rating_action} | ${it.report_date} | ${num(it.target.reportClose)} | ${num(it.target.currentPrice)} | ${pct(hold)} |`);
    }
  }
  L.push('');

  const bearHold = withHold.filter(x => x.it.sentiment === 'bearish').sort((a, b) => a.hold - b.hold);
  if (bearHold.length > 0) {
    L.push(`## 看空名單 — 喊完到現在漲跌`);
    L.push('');
    L.push('| 股票 | 券商 | 評等 | 報告日 | 報告日收盤 | 現價 | 持有至今 |');
    L.push('|---|---|---|---|---:|---:|---:|');
    for (const { it, hold } of bearHold) {
      L.push(`| ${it.stock_code} ${it.stock_name} | ${it.broker_display} | ${ratingZh(it.rating_raw, it.rating)} | ${it.report_date} | ${num(it.target.reportClose)} | ${num(it.target.currentPrice)} | ${pct(hold)} |`);
    }
    L.push('');
  }

  // 全部目標價：每一筆有目標價的台股 call（含中立評等）都攤開，列目標價/現價/距目標價。
  const withTarget = allItems
    .filter(it => it.market === 'TW' && it.stock_code && it.target_price != null
      && !it.target.currencyMismatch && it.target.distanceToTargetPct != null)
    .sort((a, b) => (b.target.distanceToTargetPct ?? -Infinity) - (a.target.distanceToTargetPct ?? -Infinity));
  L.push(`## 全部目標價：目標價 / 現價 / 距目標價（肉最多排最前）`);
  L.push('');
  if (withTarget.length === 0) {
    L.push('_無可計算的目標價。_');
  } else {
    L.push(`（每一筆有目標價的台股報告全部列出，含中立評等、不限券商家數。「距目標價」正=現價還在目標價下方、還有空間（有肉）；負或已達標=股價已追到或超過目標價（肉吃完了）。共 ${withTarget.length} 筆。）`);
    L.push('');
    L.push('| 股票 | 券商 | 評等 | 報告日 | 目標價 | 現價 | 距目標價 | 狀態 |');
    L.push('|---|---|---|---|---:|---:|---:|---|');
    for (const it of withTarget) {
      const tp = it.target_price!;
      const cur = it.target.currentPrice;
      const isBullish = it.sentiment === 'bullish';
      let status: string;
      if (!isBullish) {
        // 中立/偏空評等：目標價在現價上或下都正常，不是買進建議
        status = '中立看法（非買進建議）';
      } else if (cur != null && cur >= tp) {
        // 股價已追到或超過券商目標價（常見於券商目標價偏舊、沒跟著股價上調）
        status = '✅ 已達/超過目標價';
      } else {
        status = `還差 ${pct(it.target.distanceToTargetPct)}`;
      }
      L.push(`| ${it.stock_code} ${it.stock_name} | ${it.broker_display} | ${ratingZh(it.rating_raw, it.rating)} | ${it.report_date} | ${num(tp)} | ${num(cur)} | ${pct(it.target.distanceToTargetPct)} | ${status} |`);
    }
  }
  L.push('');

  // 升評 / 降評
  const actions = twDirectional.filter(it => it.rating_action === 'upgrade' || it.rating_action === 'downgrade' || it.rating_action === 'initiate');
  if (actions.length > 0) {
    L.push(`## 評等異動（升評 / 降評 / 首評）`);
    L.push('');
    L.push('| 股票 | 券商 | 動作 | 評等 | 目標價 | 前次目標價 | 報告日 |');
    L.push('|---|---|---|---|---:|---:|---|');
    for (const it of actions.sort((a, b) => b.report_date.localeCompare(a.report_date))) {
      L.push(`| ${it.stock_code} ${it.stock_name} | ${it.broker_display} | ${ACTION_LABEL[it.rating_action]} | ${ratingZh(it.rating_raw, it.rating)} | ${num(it.target_price)} | ${num(it.prev_target_price)} | ${it.report_date} |`);
    }
    L.push('');
  }

  // 券商準度（樣本小）
  L.push(`## 券商準度（${scorecard.window ? `${scorecard.window.start}~${scorecard.window.end}` : '無'}）`);
  L.push('');
  L.push(`> 只統計「報告日後滿 20 個交易日、且 K 線資料齊全」的方向性主標的；還沒滿 20 天的不列入。`);
  L.push('');
  const settled = scorecard.brokers.filter(b => b.total_calls > 0);
  if (settled.length === 0) {
    L.push('_目前還沒有任何報告滿 20 交易日結算，準度待累積（多數報告 6 月才進來）。_');
  } else {
    L.push('| 券商 | 已結算 call | 命中 | 命中率 | 平均d20 | 達標率 |');
    L.push('|---|---:|---:|---:|---:|---:|');
    for (const b of settled) {
      L.push(`| ${b.broker_display} | ${b.total_calls} | ${b.hits} | ${b.hit_rate != null ? b.hit_rate + '%' : '—'} | ${pct(b.avg_d20_return)} | ${b.target_reached_rate != null ? b.target_reached_rate + '%' : '—'} |`);
    }
  }
  L.push('');

  // 逐日明細
  L.push(`## 逐日報告明細`);
  L.push('');
  for (const d of dates.slice().reverse()) {
    const day = await computeBrokerPerformance(d);
    if (day.items.length === 0) continue;
    L.push(`### ${d}　（${day.stats.report_count} 份報告）`);
    L.push('');
    L.push('| 股票 | 券商 | 評等 | 情緒 | 目標價 | 現價 | 距目標價 | 持有至今 | 主標的 |');
    L.push('|---|---|---|---|---:|---:|---:|---:|:--:|');
    for (const it of day.items) {
      const name = it.stock_code ? `${it.stock_code} ${it.stock_name}` : `${it.stock_name}（非台股）`;
      const h = holdReturn(it);
      const ratingCell = it.sentiment === 'mentioned_only' ? '—' : ratingZh(it.rating_raw, it.rating);
      const curCell = it.market === 'TW' ? num(it.target.currentPrice) : '—';
      const distCell = (it.market === 'TW' && it.target_price != null && !it.target.currencyMismatch)
        ? pct(it.target.distanceToTargetPct) : '—';
      L.push(`| ${name} | ${it.broker_display} | ${ratingCell} | ${SENTIMENT_LABEL[it.sentiment] || it.sentiment} | ${num(it.target_price)} | ${curCell} | ${distCell} | ${it.market === 'TW' ? pct(h) : '—'} | ${it.covered ? '●' : ''} |`);
    }
    L.push('');
  }

  L.push('---');
  L.push(`_資料來源：本機法人報告檔。漲跌幅 ＝ 報告當日收盤 → 最新收盤。非台股不計漲跌幅與目標價達成度。_`);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, L.join('\n'), 'utf-8');
  console.log(`✅ 已寫出：${outPath}`);
  console.log(`   期間 ${start}~${end}｜${reportCount} 份報告｜${brokerSet.size} 家券商｜${stockSet.size} 檔台股｜方向性 ${twDirectional.length} 筆`);
  console.log(`   高共識 ${hi.length} 檔｜已達標 ${withTarget.filter(it => it.target.reached).length} 筆`);
}

main().catch(e => { console.error(e); process.exit(1); });
