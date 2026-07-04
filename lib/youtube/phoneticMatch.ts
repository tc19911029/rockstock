/**
 * phoneticMatch — Whisper 同音誤植的拼音自動偵測
 *
 * 問題：Whisper 常把股名聽成同音字（台聚→台劇、亞聚→雅劇、晶豪科→金豪科），
 * 字面 grep 查無 ≠ 沒講。畫面 OCR 抓到代號、逐字稿卻「查無股名」時，
 * 用拼音（去聲調 + 台灣國語常見混淆正規化）掃全逐字稿找同音嫌疑段落。
 *
 * 定位：hint 產生器 — 結果給分析端（skill / grounding / 稽核）判讀，
 * 不自動改 mention。同音常用詞（如 中纖=中線）會有 false positive，靠上下文人判。
 *
 * 2026-07-02 台聚教訓：陳唯泰整段看多，逐字稿寫成「台劇集團」，語音端全漏，
 * 只剩簡報 OCR 0.54 信心卡在 0.6 顯示門檻下。
 */

import { pinyin } from 'pinyin-pro';

export interface PhoneticHit {
  /** 逐字稿裡實際出現的同音形（如「台劇」） */
  form: string;
  /** 出現次數 */
  count: number;
  /** 首次出現的字元位置 */
  first_index: number;
  /** 首次出現的前後文（±30 字） */
  context: string;
}

/** 台灣國語常見混淆正規化：去聲調後再合併 ng/n 韻尾、翹舌/平舌。 */
function normalizeSyllable(syl: string): string {
  return syl
    .replace(/^zh/, 'z')
    .replace(/^ch/, 'c')
    .replace(/^sh/, 's')
    .replace(/ng$/, 'n')
    .replace(/ü/g, 'u');
}

const charPinyinCache = new Map<string, string>();

/** 單一漢字 → 正規化拼音（非漢字回空字串）。多音字取 pinyin-pro 預設讀音，可接受誤差。 */
function charPinyin(ch: string): string {
  const cached = charPinyinCache.get(ch);
  if (cached !== undefined) return cached;
  let py = '';
  if (/[一-鿿]/.test(ch)) {
    py = normalizeSyllable(pinyin(ch, { toneType: 'none' }).trim());
  }
  charPinyinCache.set(ch, py);
  return py;
}

/** 股名去掉非漢字部分（-KY、*、英數字尾綴）留純漢字比對段。 */
export function chineseCore(name: string): string {
  return (name.match(/[一-鿿]+/g) ?? []).join('');
}

/**
 * 在逐字稿裡找「與 name 同音但寫法不同」的片段。
 * 回傳按出現次數排序的不重複形（最多 maxForms 種）。
 */
export function findPhoneticHits(
  name: string,
  transcript: string,
  { maxForms = 3, contextChars = 30 }: { maxForms?: number; contextChars?: number } = {},
): PhoneticHit[] {
  const core = chineseCore(name);
  if (core.length < 2 || !transcript) return [];

  const target = [...core].map(charPinyin);
  if (target.some(p => !p)) return []; // 股名本身有查不到讀音的字 → 不比

  const n = core.length;
  const chars = [...transcript];
  const byForm = new Map<string, { count: number; first_index: number }>();

  for (let i = 0; i + n <= chars.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      const py = charPinyin(chars[i + j]);
      if (!py || py !== target[j]) { ok = false; break; }
    }
    if (!ok) continue;
    const form = chars.slice(i, i + n).join('');
    if (form === core) continue; // 字面完全相同 = 本尊，不算嫌疑
    const cur = byForm.get(form);
    if (cur) cur.count += 1;
    else byForm.set(form, { count: 1, first_index: i });
  }

  return [...byForm.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxForms)
    .map(([form, v]) => ({
      form,
      count: v.count,
      first_index: v.first_index,
      context: chars
        .slice(Math.max(0, v.first_index - contextChars), v.first_index + n + contextChars)
        .join('')
        .replace(/\s+/g, ' '),
    }));
}

/** 由 cue 陣列估某字元位置的影片秒數（cue 文字以空白接合的座標系）。 */
export function estimateCueTime(
  cues: Array<{ start: number; text: string }> | null | undefined,
  charIndex: number,
): number | null {
  if (!cues || cues.length === 0) return null;
  let acc = 0;
  for (const c of cues) {
    if (acc + c.text.length + 1 > charIndex) return Math.round(c.start);
    acc += c.text.length + 1;
  }
  return Math.round(cues[cues.length - 1].start);
}
