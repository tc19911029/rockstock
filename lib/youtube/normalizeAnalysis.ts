/**
 * YouTube 分析「確定性校正」(2026-05-30)
 *
 * 根因：analysis JSON 的股票代號是「模型寫分析時自己填的」(skill 指示模型寫 matched.code)，
 * 且模型只拿到 ~1200 筆抽樣 hint、不是全量 26921 筆 master → 找不到就憑聯想編代號
 * (2026-05-24 錯 5 個、2026-05-29 錯 4 個，例：光頡填 3611 實為 3624)。
 *
 * 根治：把「決定代號」從模型手裡拿走，改由程式對**全量 master** 重查。
 *
 * 本模組是純函式 (不碰 IO)，由 scripts/normalize-youtube-analysis.ts 與 cron 餵入資料。
 *
 * 做三件事：
 *  1. **代號重查 (確定性、自動修)**：對每筆 raw_query / stock_name 跑 lookupStock(全量 master)，
 *     覆寫 matched.code/name/market/confidence，並重算 combined_confidence。模型永不決定代號。
 *  2. **逐字稿 grounding (僅報告、不自動刪)**：搜「代號(阿拉伯+中文數字) / 名稱 / master alias /
 *     已知 Whisper 同音」是否真出現在逐字稿。查無 → ungrounded；只在別支出現 → videoMismatch。
 *     **絕不自動刪除或搬移**(2026-05-30 凱美誤刪教訓：name-grep 查無常是 Whisper 亂碼，不是幻覺)。
 *  3. **節目重點股校正**：video_summaries[].key_stocks 同樣以全量 master 重查；
 *     查無者移除，避免空代號或模型臆測代號流入每日報告與資料契約。
 */

import type {
  DailyAnalysis, AnalyzedStockMention, StockScoring,
  RecommendationType, MentionSourceType,
} from './analysisStorage';
import { lookupStock, type StockMasterFile } from './stockMaster';
import { findPhoneticHits } from './phoneticMatch';

// ── keyframe 欄位枚舉（2026-06-12 新欄；合約 youtube-analysis-keyframe-fields 把關）────
const VALID_RECO = new Set<string>(['明確買進', '看多', '觀察', '等回檔', '小心追高', '偏空', '只介紹']);
const VALID_SOURCE = new Set<string>(['speech', 'slide', 'speech+slide']);

/** 常見 LLM 漂移 → 合法 recommendation_type；查無對應 fallback '觀察'（最中性的「有在看不表態」） */
const RECO_ALIASES: Record<string, RecommendationType> = {
  等突破: '觀察', 突破買進: '明確買進', 突破: '明確買進', 買進: '明確買進', 加碼: '明確買進',
  強烈看多: '看多', 強力看多: '看多', 偏多: '看多', 看好: '看多',
  拉回買進: '等回檔', 拉回找買點: '等回檔', 等拉回: '等回檔', 逢低買進: '等回檔', 逢低布局: '等回檔', 回測買進: '等回檔',
  追高小心: '小心追高', 避免追高: '小心追高', 高檔小心: '小心追高',
  看空: '偏空', 賣出: '偏空', 偏空操作: '偏空', 出場: '偏空',
  中性: '只介紹', 持平: '只介紹', 介紹: '只介紹', 中立: '只介紹',
};

const SOURCE_ALIASES: Record<string, MentionSourceType> = {
  語音: 'speech', 口述: 'speech', 口播: 'speech',
  簡報: 'slide', 投影片: 'slide', 字卡: 'slide', 畫面: 'slide', 截圖: 'slide',
  '口述+簡報': 'speech+slide', 兩者: 'speech+slide',
};

/** 修一筆 mention 的 keyframe 欄位（mutate）。回傳修正描述清單。 */
function normalizeMentionFields(m: AnalyzedStockMention, where: string): string[] {
  const fixes: string[] = [];

  // screenshot_ref 絕對路徑 → data/youtube/keyframes/... 相對；無從還原則移除
  if (m.screenshot_ref !== undefined && !/^data\/youtube\/keyframes\//.test(m.screenshot_ref)) {
    const i = m.screenshot_ref.indexOf('data/youtube/keyframes/');
    if (i >= 0) {
      const rel = m.screenshot_ref.slice(i);
      fixes.push(`${where} "${m.raw_query}": screenshot_ref 絕對路徑 → ${rel}`);
      m.screenshot_ref = rel;
    } else {
      fixes.push(`${where} "${m.raw_query}": screenshot_ref 無從還原（${m.screenshot_ref}）→ 移除`);
      delete m.screenshot_ref;
    }
  }

  // recommendation_type 枚舉
  if (m.recommendation_type !== undefined && !VALID_RECO.has(m.recommendation_type)) {
    const mapped = RECO_ALIASES[m.recommendation_type] ?? '觀察';
    fixes.push(`${where} "${m.raw_query}": recommendation_type "${m.recommendation_type}" → ${mapped}`);
    m.recommendation_type = mapped;
  }

  // source_type 枚舉
  if (m.source_type !== undefined && !VALID_SOURCE.has(m.source_type)) {
    const mapped = SOURCE_ALIASES[m.source_type];
    if (mapped) {
      fixes.push(`${where} "${m.raw_query}": source_type "${m.source_type}" → ${mapped}`);
      m.source_type = mapped;
    } else {
      fixes.push(`${where} "${m.raw_query}": source_type "${m.source_type}" 無對應 → 移除（降回 speech 預設）`);
      delete m.source_type;
    }
  }

  // 數值欄非正數 → 移除（不可憑空編造）；mention_time 允許 0
  for (const key of ['mention_time', 'mentioned_price', 'target_price', 'stop_loss'] as const) {
    const v = m[key];
    if (v === undefined) continue;
    const ok = Number.isFinite(v) && (key === 'mention_time' ? v >= 0 : v > 0);
    if (!ok) {
      fixes.push(`${where} "${m.raw_query}": ${key}=${v} 非法 → 移除`);
      delete m[key];
    }
  }

  return fixes;
}

/** 已確認的 Whisper 同音 (code → 逐字稿可能出現的亂碼形)。只給 grounding 用，不灌進 lookupStock
 *  的 ALIAS_MAP(避免「鑑定/盟力/超風」等通用詞污染代號查詢)。新發現補這裡。 */
const WHISPER_HOMONYMS: Record<string, string[]> = {
  '3006': ['金豪科', '金豪可', '金豪客'],   // 晶豪科
  '1304': ['台劇', '臺巨', '台巨'], // 台聚（「台劇集團」= 台聚集團，2026-07-02 理財達人秀/錢線實例）
  '1308': ['雅劇', '雅巨'],    // 亞聚
  '2408': ['藍牙坑'],          // 南亞科（n/l 聲母混淆，拼音比對蓋不到 → 必須靜態列）
  '6770': ['立基電', '立基墊', '立機店', '利機店'], // 力積電
  '3624': ['光潔'],            // 光頡
  '3131': ['紅塑'],            // 弘塑
  '6282': ['康熟'],            // 康舒
  '6285': ['起機'],            // 啟碁
  '3044': ['鑑定'],            // 健鼎
  '6134': ['萬序'],            // 萬旭
  '8016': ['細創'],            // 矽創
  '4958': ['錚頂'],            // 臻鼎
  '4966': ['普瑞'],            // 譜瑞
  '2464': ['盟力'],            // 盟立
  '6147': ['齊邦'],            // 頎邦
  '3491': ['升達科', '森達科'], // 昇達科
  '3090': ['日電帽', '日電貌'], // 日電貿
  '2368': ['金像店'],          // 金像電
  '1815': ['富橋'],            // 富喬
  '2441': ['超風'],            // 超豐
  '6451': ['訊心'],            // 訊芯
  '3016': ['加晶', '家晶'],     // 嘉晶
  '2472': ['立龍電'],          // 立隆電
  '6173': ['信昌'],            // 信昌電（"信昌店" 等亂碼以 prefix 命中）
  '6175': ['利敦'],            // 立敦
  '6515': ['影威'],            // 穎崴
  '5483': ['中美金'],          // 中美晶（晶→金，同段「環球金/細金圓」一致）
};

const CN_DIGITS: Record<string, string> = {
  '0': '零', '1': '一', '2': '二', '3': '三', '4': '四',
  '5': '五', '6': '六', '7': '七', '8': '八', '9': '九',
};
/** "3624" → "三六二四"（分析師常用中文數字報代號，Whisper 對數字較準）。 */
function toChineseDigits(code: string): string {
  return code.split('').map(d => CN_DIGITS[d] ?? d).join('');
}

export interface CodeFix {
  where: string;          // e.g. "high_consensus_stocks[3]"
  raw_query: string;
  oldCode: string | null;
  newCode: string | null; // null = 重查不到 → matched 設為 null
  via: string;            // 'exact_code' | 'alias' | … | 'unresolved'
}

export interface GroundingFlag {
  where: string;
  name: string;
  code: string;
  claimedVideo: string | null;
  foundIn: string[];      // 證據實際出現的影片(空=完全查無)
  matchedForm?: string;   // 命中的形式(代號/名/同音)
}

export interface NormalizeReport {
  codeFixes: CodeFix[];      // 代號被改的(含改成 null)
  fieldFixes: string[];      // keyframe 欄位自動修正(screenshot_ref/reco/source/數值)
  ungrounded: GroundingFlag[];   // 全逐字稿查無 → 待人工複查(可能幻覺，但也可能 Whisper 亂碼)
  videoMismatches: GroundingFlag[]; // 證據在別支、非標的影片 → 歸屬可能錯
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 對一筆 mention 重查代號並覆寫 matched。回傳 codeFix(若有變動)或 null。 */
function reResolveMention(
  m: AnalyzedStockMention,
  master: StockMasterFile,
  where: string,
): CodeFix | null {
  const oldCode = m.matched?.code ?? null;
  const resolved = lookupStock(m.raw_query, master);

  if (!resolved) {
    // 全量 master 都查不到 → 不主張代號(模型先前填的視為不可信)
    const changed = m.matched != null;
    m.matched = null;
    m.combined_confidence = 0;
    return changed ? { where, raw_query: m.raw_query, oldCode, newCode: null, via: 'unresolved' } : null;
  }

  const changed = oldCode !== resolved.code || m.matched?.name !== resolved.name;
  m.matched = resolved;
  m.combined_confidence = round2(m.llm_confidence * resolved.confidence);
  return changed ? { where, raw_query: m.raw_query, oldCode, newCode: resolved.code, via: resolved.match_via } : null;
}

/** 一檔在逐字稿的所有可搜形式：代號、中文數字代號、名、master alias、已知同音。 */
function groundingForms(code: string, name: string, master: StockMasterFile): string[] {
  const forms = new Set<string>([code, toChineseDigits(code), name]);
  const entry = master.entries.find(e => e.code === code);
  for (const a of entry?.aliases ?? []) forms.add(a);
  for (const h of WHISPER_HOMONYMS[code] ?? []) forms.add(h);
  // 去掉太短(<2)或純通用的形(避免雜訊)；代號數字保留
  return [...forms].filter(f => f.length >= 2);
}

/** 對一個 code/name 做 grounding：回傳 {foundIn, matchedForm}。 */
function ground(
  code: string,
  name: string,
  master: StockMasterFile,
  transcriptsByVideo: Record<string, string>,
): { foundIn: string[]; matchedForm?: string } {
  const forms = groundingForms(code, name, master);
  const foundIn: string[] = [];
  let matchedForm: string | undefined;
  for (const [vid, text] of Object.entries(transcriptsByVideo)) {
    const hit = forms.find(f => text.includes(f));
    if (hit) { foundIn.push(vid); matchedForm ??= hit; }
  }
  if (foundIn.length > 0) return { foundIn, matchedForm };

  // 字面/已知同音全查無 → 拼音退路：掃 Whisper 未知同音誤植（台聚→「台劇」這類），
  // 找到就不誤標 ungrounded（matchedForm 註記「音似」供人判）。
  for (const [vid, text] of Object.entries(transcriptsByVideo)) {
    const hits = findPhoneticHits(name, text, { maxForms: 1 });
    if (hits.length > 0) { foundIn.push(vid); matchedForm ??= `${hits[0].form}(音似)`; }
  }
  return { foundIn, matchedForm };
}

export function normalizeAnalysis(
  analysis: DailyAnalysis,
  master: StockMasterFile,
  transcriptsByVideo: Record<string, string>,
): { analysis: DailyAnalysis; report: NormalizeReport } {
  const report: NormalizeReport = { codeFixes: [], fieldFixes: [], ungrounded: [], videoMismatches: [] };

  const mentionArrays: Array<[string, AnalyzedStockMention[]]> = [
    ['high_consensus_stocks', analysis.high_consensus_stocks ?? []],
    ['weak_signal_stocks', analysis.weak_signal_stocks ?? []],
  ];

  for (const [label, arr] of mentionArrays) {
    arr.forEach((m, i) => {
      const where = `${label}[${i}]`;
      const fix = reResolveMention(m, master, where);
      if (fix) report.codeFixes.push(fix);

      // keyframe 欄位正規化（screenshot_ref/reco/source/數值）
      report.fieldFixes.push(...normalizeMentionFields(m, where));

      // grounding（只對有 code 的）
      if (m.matched) {
        const { foundIn, matchedForm } = ground(m.matched.code, m.matched.name, master, transcriptsByVideo);
        const flag: GroundingFlag = {
          where, name: m.matched.name, code: m.matched.code,
          claimedVideo: m.video_id ?? null, foundIn, matchedForm,
        };
        if (foundIn.length === 0) report.ungrounded.push(flag);
        else if (m.video_id && !foundIn.includes(m.video_id)) report.videoMismatches.push(flag);
      }
    });
  }

  // stock_scoring：用 stock_name 重查、修正 stock_code（無 raw_query/matched 結構）
  if (analysis.stock_scoring) {
    analysis.stock_scoring.forEach((s: StockScoring, i: number) => {
      const where = `stock_scoring[${i}]`;
      const resolved = lookupStock(s.stock_name, master);
      if (resolved && resolved.code !== s.stock_code) {
        report.codeFixes.push({ where, raw_query: s.stock_name, oldCode: s.stock_code, newCode: resolved.code, via: resolved.match_via });
        s.stock_code = resolved.code;
        s.stock_name = resolved.name;
      }
    });
  }

  // video_summaries：模型常能辨識名稱，卻會把 code 留空或憑印象填錯。
  // 名稱優先、代號退路；全量 master 都查不到就不保留，避免持久化無法 join 的重點股。
  if (analysis.video_summaries) {
    analysis.video_summaries.forEach((summary, videoIndex) => {
      const normalized: typeof summary.key_stocks = [];
      const seenCodes = new Set<string>();

      (summary.key_stocks ?? []).forEach((stock, stockIndex) => {
        const where = `video_summaries[${videoIndex}].key_stocks[${stockIndex}]`;
        const resolved = lookupStock(stock.name, master) ?? lookupStock(stock.code, master);
        if (!resolved) {
          report.codeFixes.push({
            where,
            raw_query: stock.name || stock.code,
            oldCode: stock.code || null,
            newCode: null,
            via: 'unresolved',
          });
          return;
        }

        if (stock.code !== resolved.code || stock.name !== resolved.name) {
          report.codeFixes.push({
            where,
            raw_query: stock.name || stock.code,
            oldCode: stock.code || null,
            newCode: resolved.code,
            via: resolved.match_via,
          });
        }
        if (seenCodes.has(resolved.code)) return;
        seenCodes.add(resolved.code);
        normalized.push({ code: resolved.code, name: resolved.name });
      });

      summary.key_stocks = normalized;
    });
  }

  return { analysis, report };
}
