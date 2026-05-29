#!/usr/bin/env tsx
/**
 * 對 5 檔 A 級候選 (2330/2308/3090/2317/2484) 套用 WebFetch 拿到的真實資料，重算 score + composite。
 * 2330 已 inline edit 過。
 */
import fs from 'node:fs';

const FILE = 'data/youtube/analysis/2026-05-25.json';
const analysis = JSON.parse(fs.readFileSync(FILE, 'utf-8'));

const fetchedAt = '2026-05-26T06:30:00Z';

const patches: Record<string, any> = {
  '2308': {
    factor_scores: { technical: 82, chip: 85, fundamental: 80, news: 80, mention_heat: 70, industry: 88, macro: 90, valuation: 55, governance: 65 },
    action: 'Rubin 600kW 電力革命 + HVDC/液冷 AI 雙助攻，三大法人 +4918 大買續抱',
    risk_flags: ['governance 4w 變化未取得（FinMind 失效）', '投信過往砍倉壓力'],
    reasoning: '5/25 三大法人 +4918 全面轉買（外資連2賣→買 +4330、投信連8賣→買 +203、自營連3買 +385）；HVDC/液冷 AI 營收佔比衝 40%；5 條新聞全利多',
    evidence: {
      chip: { url: 'https://tw.stock.yahoo.com/quote/2308.TW/institutional-trading', raw_quote: '外資 連2賣→買 +4330、投信 連8賣→買 +203、自營商 連3買 +385、三大法人 賣→買 +4918', values: { foreign_net: 4330, trust_net: 203, dealer_net: 385, total_inst_net: 4918 } },
      news: { url: 'https://tw.stock.yahoo.com/quote/2308.TW/news', raw_quote: '5/25 5 條：開高走高首收43K、AI營收衝40% HVDC液冷雙助攻、強漲近9%挑戰2300', values: { item_count: 5, recent_titles: ['台達電AI營收占比衝40% HVDC/液冷布局雙助攻', '股價緊逼台積電！台達電強漲近9%挑戰2300元大關', '台股大漲1376點首度收43K 台達電飆逾9%'] } },
      industry: { url: 'https://tw.stock.yahoo.com/quote/2308.TW', raw_quote: '電子零組件', values: { category: '電子零組件' } },
    },
  },
  '3090': {
    factor_scores: { technical: 92, chip: 75, fundamental: 80, news: 75, mention_heat: 65, industry: 85, macro: 90, valuation: 55, governance: 55 },
    action: '被動元件代理王 + 三大法人 +816 連3買 + 4月營收 +28%，續抱',
    risk_flags: ['短線乖離大', 'governance 4w 變化未取得'],
    reasoning: '5/25 三大法人 +816 連3買累計 +4538（外資連3買 +2367）；4 月營收 +28.14%；新董事長文曄鄭文宗就任',
    evidence: {
      chip: { url: 'https://tw.stock.yahoo.com/quote/3090.TW/institutional-trading', raw_quote: '外資 1,524 721 803 連3買 (2,367)；投信 0；自營商 32 19 13 連4賣→買；三大法人 1,556 740 816 連3買 (4,538)', values: { foreign_net: 803, trust_net: 0, dealer_net: 13, total_inst_net: 816 } },
      news: { url: 'https://tw.stock.yahoo.com/quote/3090.TW/news', raw_quote: '5/22 股東會、5/22 文曄董座鄭文宗獲選日電貿新任董事長、5/7 4月營收 +28.14%', values: { item_count: 5, recent_titles: ['日電貿股東常會重要決議事項', '文曄董座鄭文宗獲選新任董事長', '4月合併營收18.43億元 年增28.14%'] } },
      industry: { url: 'https://tw.stock.yahoo.com/quote/3090.TW', raw_quote: '電子零組件 / PER 44.79 (同業 73.81)', values: { category: '電子零組件' } },
    },
  },
  '2317': {
    // 已有 chip + fund + governance + industry，只缺 news
    news_patch_only: true,
    factor_scores_delta: { news: 70 },  // 50 → 70
    reasoning_append: '5/25 外資狂買 494 億、鴻海被加碼 5 萬張、6 大富豪身價暴增',
    evidence: {
      news: { url: 'https://tw.stock.yahoo.com/quote/2317.TW/news', raw_quote: '5/25 外資狂買494億加碼鴻海5萬張、台股43K新高 AI供應鏈多頭未完、528兆元宴 6大富豪身價暴增', values: { item_count: 5, recent_titles: ['外資狂買494億 加碼鴻海5萬張', '台股暴衝收43K新高 AI供應鏈多頭未完', '黃仁勳528兆元宴 6大富豪身價暴增'] } },
    },
  },
  '2484': {
    news_patch_only: true,
    factor_scores_delta: { news: 55 },  // 50 → 55
    reasoning_append: '5/25 處置股注意揭露，5/8 4 月營收 +0.03% 持平',
    evidence: {
      news: { url: 'https://tw.stock.yahoo.com/quote/2484.TW/news', raw_quote: '5/25 處置股注意揭露、5/8 4月合併營收2.34億年增0.03%', values: { item_count: 5, recent_titles: ['希華 達公布注意交易資訊標準', '4月合併營收2.34億元 年增0.03%', '日本希華科技公告 2026年股東臨時會'] } },
    },
  },
};

const WEIGHTS: Record<string, number> = { technical: 25, chip: 18, fundamental: 15, news: 12, mention_heat: 10, industry: 10, macro: 5, valuation: 3, governance: 2 };

function calcComposite(scores: Record<string, number>): number {
  let w = 0;
  for (const k of Object.keys(WEIGHTS)) w += WEIGHTS[k] * (scores[k] ?? 50);
  return Math.round(w / 100 * 10) / 10;
}

function calcRating(c: number): string {
  if (c >= 75) return 'A';
  if (c >= 60) return 'B';
  if (c >= 45) return 'C';
  return 'D';
}

let patched = 0;
for (const s of analysis.stock_scoring ?? []) {
  const p = patches[s.stock_code];
  if (!p) continue;

  if (p.news_patch_only) {
    // 只 patch news evidence + score
    s.factor_evidence.news = {
      data_provenance: 'web',
      values: p.evidence.news.values,
      sources: [{ url: p.evidence.news.url, fetched_at: fetchedAt, raw_quote: p.evidence.news.raw_quote }],
    };
    for (const k of Object.keys(p.factor_scores_delta)) {
      s.factor_scores[k] = p.factor_scores_delta[k];
    }
    s.reasoning = (s.reasoning ?? '') + '；' + p.reasoning_append;
  } else {
    // 全面 patch
    s.factor_scores = p.factor_scores;
    s.action = p.action;
    s.risk_flags = p.risk_flags;
    s.reasoning = p.reasoning;
    for (const factor of ['chip', 'news', 'industry']) {
      const e = p.evidence[factor];
      if (!e) continue;
      s.factor_evidence[factor] = {
        data_provenance: 'web',
        values: e.values,
        sources: [{ url: e.url, fetched_at: fetchedAt, raw_quote: e.raw_quote }],
      };
    }
  }

  const newComp = calcComposite(s.factor_scores);
  const newRating = calcRating(newComp);
  console.log(`[${s.stock_code} ${s.stock_name}] composite ${s.composite_score} → ${newComp} (${s.rating} → ${newRating})`);
  s.composite_score = newComp;
  s.rating = newRating;
  patched++;
}

// 重算 rating_distribution
const dist: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
for (const s of analysis.stock_scoring ?? []) {
  dist[s.rating ?? 'D']++;
}
analysis.stats.rating_distribution = dist;

fs.writeFileSync(FILE, JSON.stringify(analysis, null, 2) + '\n');
console.log(`\nPatched ${patched} stocks. New rating distribution:`, dist);
