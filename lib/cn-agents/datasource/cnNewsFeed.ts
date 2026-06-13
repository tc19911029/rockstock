/**
 * 陸股新聞/政策快訊 — 給 P3 政策/題材 skill 的素材（best-effort，非阻斷）
 *
 * 用途：把當日財經 7x24 快訊整理成 digest，程式粗標「政策候選」(policyCandidate)，
 * skill 讀 question.json 時優先看標紅/政策條目做「政策→題材」映射。新聞抓不到也
 * 不擋 compose（skill 可自行 web search 補政策），故設計成失敗回空 digest。
 *
 * 源（cls.cn 本機常卡住已棄；2026-06-13 實測）：
 *   - 主：東財 7x24（akshare stock_info_global_em，~200 條乾淨 標題/摘要/時間）
 *   - 備：新浪 7x24 直連（zhibo.sina.com.cn，rich_text，Node fetch 可達）
 *
 * 只取「今日」條目（政策是前瞻性的，只有今天的對今天決策有意義 — 不做歷史回填）。
 */

import { runAkshareBridge } from '@/lib/datasource/akshareBridge';
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';
import type { NewsItem } from '../types';

/** 政策關鍵詞（命中即 policyCandidate=true）— 部委/央行/高層會議/監管 */
const POLICY_KEYWORDS = [
  '国务院', '国常会', '中央', '政治局', '发改委', '工信部', '财政部', '央行',
  '人民银行', '证监会', '银保监', '金融监管', '商务部', '科技部', '能源局',
  '住建部', '统计局', '海关总署', '外汇局', '部委', '政策', '规划', '通知',
  '意见', '方案', '补贴', '降准', '降息', 'LPR', '关税', '出口管制', '反垄断',
  '国资委', '国企改革', '专项债', '财政', '货币政策', '扩内需', '刺激',
];

function markPolicy(title: string, summary: string | null): boolean {
  const text = `${title} ${summary ?? ''}`;
  return POLICY_KEYWORDS.some((k) => text.includes(k));
}

/** 來源時間字串 → YYYY-MM-DD（抓不到回 null） */
function toDateStr(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

interface FetchResult {
  source: 'em-7x24' | 'sina-7x24' | 'none';
  items: NewsItem[];
}

/** 東財 7x24（akshare） */
async function fetchEm(targetDate: string): Promise<NewsItem[]> {
  const rows = await runAkshareBridge('news_em', 'now', 25_000);
  const out: NewsItem[] = [];
  for (const r of rows) {
    const title = typeof r.title === 'string' ? r.title : '';
    if (!title) continue;
    const summary = typeof r.summary === 'string' ? r.summary : null;
    const pt = typeof r.publishTime === 'string' ? r.publishTime : null;
    // 只留今日（publishTime 可能只有 HH:MM:SS → 視為今日；有日期則嚴格比對）
    const d = toDateStr(pt);
    if (d && d !== targetDate) continue;
    out.push({ title, summary, publishTime: pt, url: typeof r.url === 'string' ? r.url : null, policyCandidate: markPolicy(title, summary) });
  }
  return out;
}

interface SinaFeedResp {
  result?: { data?: { feed?: { list?: Array<{ rich_text?: string; create_time?: string; docurl?: string }> } } };
}

/** 新浪 7x24 直連 */
async function fetchSina(targetDate: string): Promise<NewsItem[]> {
  const url = 'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152&type=0';
  const { data } = await fetchJsonWithCurlFallback<SinaFeedResp>(url, { timeoutMs: 12_000 });
  const list = data?.result?.data?.feed?.list ?? [];
  const out: NewsItem[] = [];
  for (const r of list) {
    const text = (r.rich_text ?? '').trim();
    if (!text) continue;
    const d = toDateStr(r.create_time ?? null);
    if (d && d !== targetDate) continue;
    // rich_text 開頭常是【標題】內文 — 拆標題
    const tm = text.match(/^[【\[](.+?)[】\]]/);
    const title = tm ? tm[1] : text.slice(0, 40);
    const summary = tm ? text.slice(tm[0].length).trim() || null : text;
    out.push({ title, summary, publishTime: r.create_time ?? null, url: r.docurl ?? null, policyCandidate: markPolicy(title, summary) });
  }
  return out;
}

/** 抓當日新聞 digest（EM 主 → Sina 備 → 空）。 */
export async function fetchCnNewsDigest(targetDate: string): Promise<FetchResult> {
  try {
    const items = await fetchEm(targetDate);
    if (items.length > 0) return { source: 'em-7x24', items };
  } catch { /* fall through */ }
  try {
    const items = await fetchSina(targetDate);
    if (items.length > 0) return { source: 'sina-7x24', items };
  } catch { /* fall through */ }
  return { source: 'none', items: [] };
}
