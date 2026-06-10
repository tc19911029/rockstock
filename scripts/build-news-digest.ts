/**
 * 建立每日消息面 digest：把晨報新聞點到的個股，對照「持股 + 法人報告」存成一層訊號。
 *
 * 用法：npx tsx scripts/build-news-digest.ts [YYYY-MM-DD]
 *
 * MENTIONS 由人工從當日晨報 docx 整理（電子時報/工商時報/經濟日報），
 * 程式負責：驗證代號 + 自動交叉比對持股/法人報告 + 算交叉訊號 + 存檔。
 */

import fs from 'node:fs';
import path from 'node:path';
import { saveNewsDigest, type NewsDigest, type NewsMention, type NewsSentiment } from '@/lib/broker/newsDigest';
import { loadStockMaster } from '@/lib/youtube/stockMaster';

const DATE = process.argv[2] || '2026-06-10';

interface Spec { code: string; name: string; headlines: string[]; sentiment: NewsSentiment; }

// 2026-06-10 晨報整理（科技組為主；持股/法人報告相關優先）
const MENTIONS: Spec[] = [
  { code: '3008', name: '大立光', sentiment: 'bullish',
    headlines: ['CPO 9月前架設第一條光纖陣列自動化試產線（林恩平）', '客戶新機遞延、Q4 更旺', '外資（花旗）目標價喊到 5,325 元'] },
  { code: '6409', name: '旭隼', sentiment: 'bearish',
    headlines: ['需求轉弱、全年展望保守'] },
  { code: '2308', name: '台達電', sentiment: 'bullish',
    headlines: ['5 月營收寫最旺、年增 43.7%、出貨動能升溫'] },
  { code: '2301', name: '光寶科', sentiment: 'bullish',
    headlines: ['AI 伺服器電源 5 月年月雙增、雲端業務年增約 8 成', '打入電源雙雄鏈'] },
  { code: '8210', name: '勤誠', sentiment: 'bullish',
    headlines: ['機殼廠 5 月營收年增 37%、看好 2H26 動能'] },
  { code: '5347', name: '世界先進', sentiment: 'bullish',
    headlines: ['全年動能續強（AI/HPC/電源管理）', '5 月營收月增 5%、新加坡新廠明年量產'] },
  { code: '2317', name: '鴻海', sentiment: 'bullish',
    headlines: ['蘋果 WWDC 三亮點帶旺台鏈', '與夏普分進合擊 AI 伺服器', '攜博楓投資越南 1GW 綠能'] },
  { code: '2327', name: '國巨', sentiment: 'neutral',
    headlines: ['率先導入 SAP AI 代理於供應鏈場景'] },
  { code: '2357', name: '華碩', sentiment: 'neutral',
    headlines: ['5 月營收月減 15%（宏碁減 16%）', '宏碁、華碩 5 月營收飆高音'] },
  // 新聞熱、但法人報告未收錄（觀察候選）
  { code: '2376', name: '技嘉', sentiment: 'bullish',
    headlines: ['AI 訂單看到 2027 年、預估 Q2 營收創高'] },
  { code: '3711', name: '日月光投控', sentiment: 'bullish',
    headlines: ['營收寫最旺 5 月、年增 28.6%、先進封測躍進'] },
  // 中信投顧早報「重點新聞」
  { code: '3376', name: '新日興', sentiment: 'bullish',
    headlines: ['折疊機加持、拚 H2 回溫', '衝刺折疊機業務'] },
  { code: '6788', name: '華景電', sentiment: 'bullish',
    headlines: ['5 月營收 2.69 億、年增 24.96%（MoneyDJ）'] },
];

function ratingZh(r: string): string {
  return ({ buy: '買進', overweight: '加碼', neutral: '中立', hold: '持有', underweight: '減碼', sell: '賣出' } as Record<string, string>)[r] || '提及';
}

async function main() {
  const master = await loadStockMaster();
  const byCode = new Map(master.entries.map(e => [e.code, e]));

  // 持股代號
  const holdings = new Set<string>();
  try {
    const h = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/agents/portfolio/holdings.json'), 'utf-8'));
    const arr = Array.isArray(h) ? h : (h.holdings || h.positions || []);
    for (const x of arr) {
      const sym = String(x.symbol || x.code || x.ticker || '').replace(/\.(TW|TWO)$/i, '');
      if (sym) holdings.add(sym);
    }
  } catch { /* 無持股檔 */ }

  // 法人報告：code → 各券商立場
  const brokerByCode = new Map<string, Map<string, { rating: string; action: string }>>();
  const repDir = path.join(process.cwd(), 'data/broker/reports');
  for (const f of fs.existsSync(repDir) ? fs.readdirSync(repDir) : []) {
    if (!f.endsWith('.json')) continue;
    const day = JSON.parse(fs.readFileSync(path.join(repDir, f), 'utf-8'));
    for (const r of day.reports) for (const s of r.stocks) {
      if (!s.matched) continue;
      const m = brokerByCode.get(s.matched.code) ?? new Map();
      // 同券商取有評等者優先
      const prev = m.get(r.broker_display);
      if (!prev || (prev.rating === 'other' && s.rating !== 'other')) m.set(r.broker_display, { rating: s.rating, action: s.rating_action });
      brokerByCode.set(s.matched.code, m);
    }
  }

  const mentions: NewsMention[] = MENTIONS.map(spec => {
    const entry = byCode.get(spec.code);
    if (!entry) console.warn(`⚠ 代號 ${spec.code}（${spec.name}）不在 master，請確認`);
    const inHold = holdings.has(spec.code);
    const bro = brokerByCode.get(spec.code);
    const inBroker = !!bro && bro.size > 0;
    let brokerView: string | null = null;
    if (bro && bro.size) {
      brokerView = Array.from(bro.entries())
        .map(([disp, v]) => `${disp}${ratingZh(v.rating)}${v.action === 'upgrade' ? '(升評)' : ''}`)
        .join('·');
    }
    // 交叉訊號
    let cross: string | null = null;
    if (inBroker) {
      const dirs = Array.from(bro!.values()).map(v => v.rating);
      const bull = dirs.filter(r => r === 'buy' || r === 'overweight').length;
      const bear = dirs.filter(r => r === 'sell' || r === 'underweight').length;
      const brokerDir = bull > bear ? 'bull' : bear > bull ? 'bear' : 'neutral';
      if (spec.sentiment === 'bullish' && brokerDir === 'bull') cross = '✅ 新聞印證法人偏多';
      else if (spec.sentiment === 'bearish' && brokerDir !== 'bull') cross = '✅ 新聞印證法人保守';
      else if (spec.sentiment === 'bearish' && brokerDir === 'bull') cross = '⚠️ 新聞轉弱、與法人偏多矛盾，留意';
      else if (spec.sentiment === 'bullish' && brokerDir !== 'bull') cross = '📌 新聞偏多、法人較保守';
      else cross = '新聞中性、與法人立場並列';
    } else {
      cross = '🆕 法人報告未收錄、新聞熱，可考慮納入觀察';
    }
    return {
      code: spec.code,
      name: entry?.name ?? spec.name,
      market: 'TW' as const,
      headlines: spec.headlines,
      sentiment: spec.sentiment,
      in_holdings: inHold,
      in_broker_reports: inBroker,
      broker_view: brokerView,
      cross_signal: cross,
    };
  });

  const digest: NewsDigest = {
    date: DATE,
    source: '晨報（電子時報/工商時報/經濟日報）',
    generated_at: new Date().toISOString(),
    mentions,
    stats: {
      total: mentions.length,
      holdings_hit: mentions.filter(m => m.in_holdings).length,
      broker_report_hit: mentions.filter(m => m.in_broker_reports).length,
      bullish: mentions.filter(m => m.sentiment === 'bullish').length,
      bearish: mentions.filter(m => m.sentiment === 'bearish').length,
      neutral: mentions.filter(m => m.sentiment === 'neutral').length,
    },
  };

  await saveNewsDigest(digest);
  console.log(`✓ 寫出 data/news-digest/${DATE}.json：${mentions.length} 檔（持股命中 ${digest.stats.holdings_hit}、法人報告命中 ${digest.stats.broker_report_hit}）`);
  console.log('\n持股今日有無上新聞：', holdings.size ? Array.from(holdings).map(c => `${c}${mentions.some(m => m.code === c) ? '✓有' : '✗無'}`).join('、') : '（無持股檔）');
  for (const m of mentions) {
    console.log(`  ${m.code} ${m.name} [${m.sentiment}] ${m.in_holdings ? '【持股】' : ''}${m.in_broker_reports ? '法人:' + m.broker_view : '(法人無)'} → ${m.cross_signal}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
