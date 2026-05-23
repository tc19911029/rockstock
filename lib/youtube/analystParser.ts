/**
 * 解析影片標題裡的「分析師名單」。
 *
 * 為什麼需要：理財達人秀 / 57同學會 / 兆華艾綸說 / 錢線百分百 / 金臨天下 / 股民開講
 * 都有來賓輪替（朱家泓、蔡明翰、容逸燊、權證小哥、王建文、不魯、曲博、林漢偉…）。
 * 只標 source_id 沒辦法分辨「這檔股票是朱家泓推還是蔡明翰推」。
 *
 * 策略：
 *   1. 以節目固定主持人 (source.default_analysts) 為基底
 *   2. 從標題抓「人名 token」併進去
 *   3. 嚴格白名單：只認得已知的分析師名字，避免抓到股票代號 / 一般名詞
 *
 * 為什麼用白名單而不是 generic NLP：標題中文字很雜（含股票名、公司名、概念股名），
 * 用 NLP 抓人名 false positive 太高。白名單雖然要維護，但漏抓比誤抓好。
 */

/**
 * 已知分析師名字（中文）— 出現在標題的「｜...、...」段。
 * 新增時也要更新 sourceRegistry.default_analysts 對應節目的固定 cast。
 */
export const KNOWN_ANALYSTS: ReadonlySet<string> = new Set([
  // 一人節目主秀
  '蔡萬得', '涂敏峰', '藍登耀', '許毓玲', '陳威良',
  '劉育綸', '艾綸',                       // 艾綸說（直播）
  // 兆華艾綸說 固定
  '李兆華',
  // 理財達人秀 來賓（rotating，會持續擴充）
  '朱家泓', '蔡明翰', '容逸燊', '權證小哥', '王建文', '不魯',
  // 兆華艾綸說 來賓
  '曲博', '曲建仲',
  // 57股市同學會 主持 + 來賓
  '鄭明娟', '林漢偉', '阮慕驊', '陳唯泰', '柯建維', '高志銘',
  // 錢線百分百 來賓
  '陳建文', '陳明君', '張啟仁', '尤可欣', '黃靖哲', '王榮旭', '袁誠均', '林昇',
  // 金臨天下 來賓
  '王志郁',
  // 決勝關鍵
  '楚河', '楚軒',
  // 金融鬼谷子（同 source name 但有時標題另寫）
  // 涂敏峰 已在上
]);

/**
 * 從標題抽人名 token。兩條 path 都跑、結果合併去重：
 *   A. 白名單法：找 2-4 字中文 token，跟 KNOWN_ANALYSTS 取交集。
 *   B. Delimiter 法：抓「｜...、...、... [date|part|【|完整版]」這段，
 *      用「、」拆，每段 trim 後若是 2-4 字中文 / 含罕用字 / 含「分析師」前綴
 *      就視為分析師。能補白名單沒收錄的（鍾國忠、翁士峻、范博洋…）。
 */
export function extractAnalystsFromTitle(title: string): string[] {
  if (!title) return [];
  const found = new Set<string>();

  // A: 白名單交集
  const tokens = title.match(/[一-鿿]{2,4}/g) ?? [];
  for (const t of tokens) {
    if (KNOWN_ANALYSTS.has(t)) found.add(t);
  }

  // B: ｜ 後的人名清單。
  //    抓 `｜...` 後到第一個 (日期 / "【" / "part" / "完整版" / 標題結尾) 之前的內容。
  const piMatches = title.matchAll(/[｜|]\s*([^【\n]+?)(?=\s*(?:20\d{2}[./\-]|【|part|完整版|$))/g);
  for (const m of piMatches) {
    const segment = m[1] ?? '';
    // 用「、」「,」「，」拆
    const parts = segment.split(/[、,，]/).map(s => s.trim());
    for (const part of parts) {
      // 純 2-4 字中文 → 視為分析師名（補白名單沒收的）
      if (/^[一-鿿]{2,4}$/.test(part)) {
        found.add(part);
        continue;
      }
      // 「XX 分析師」前綴 → 抓 XX
      const m2 = part.match(/^([一-鿿]{2,4})(?:\s*分析師)?$/);
      if (m2 && m2[1]) found.add(m2[1]);
    }
  }

  return [...found];
}

/**
 * 計算該影片完整分析師名單 = default + 標題抽到的（去重）。
 * 如果都沒有 → 退回 fallbackName（通常是節目 display_name，例：「錢線百分百」），
 * 表示「整集都是 XX 節目的觀點，沒明確掛單一分析師」。
 * 連 fallbackName 都沒 → ['(未知)']。
 */
export function resolveAnalystsForVideo(
  title: string,
  defaultAnalysts: string[] | undefined,
  fallbackName?: string,
): string[] {
  const fromTitle = extractAnalystsFromTitle(title);
  const merged = new Set<string>([...(defaultAnalysts ?? []), ...fromTitle]);
  if (merged.size === 0) {
    return fallbackName ? [fallbackName] : ['(未知)'];
  }
  return [...merged];
}
