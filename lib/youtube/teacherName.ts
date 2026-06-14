/**
 * 老師（分析師）顯示名清洗 — 從 YoutubeProgramStocks 抽出共用，
 * 讓「節目卡顯示」與「推薦事件抽取（recoEvents）」吃同一套規則。
 *
 * 例：「高獻榮(金臨天下)」→「高獻榮」、「智霖(錢線百分百)」→「智霖」；
 * 丟掉等於節目名 / (未知) / 主持群 / 純主持人 的 fallback（代表 LLM 沒指名具體老師）。
 */

/**
 * 已知「非分析師」名單：純主持人 / 報幕者 — 被 LLM 列進 analysts 也不算老師。
 * ⚠️ 只放「不講自己看法、只介紹別的分析師」的人；單人節目的主持人本身就是分析師
 *    （如雷老闆、李蜀芳）不可放，否則會誤殺真老師。
 *   - 林俊豪：股市全威主持人，開場介紹陳威良/陳一群，自己不報股。
 */
const NON_TEACHER_NAMES = new Set<string>([
  '林俊豪',
]);

const hasCJK = (s: string): boolean => /[一-鿿]/.test(s);

/**
 * @param analysts     LLM 寫的 analysts 陣列
 * @param displayName  這筆 mention 來源節目的顯示名（用於裸名比對 + fallback 命名）
 * @param programNames （選填）全部節目的 display_name + 裸名集合 —
 *                     用來擋「跨節目誤把別台節目名寫進 analysts」與「source_id 欄被寫成 video_id 害裸名比對失效」。
 */
export function cleanTeacherNames(
  analysts: string[] | undefined,
  displayName: string,
  programNames?: Set<string>,
): string[] {
  // 頻道裸名 = displayName 去掉括號（「決勝關鍵（每日台股解盤）」→「決勝關鍵」）。
  const channelBare = displayName.replace(/[（(][^（()）]*[）)]/g, '').trim();
  const out: string[] = [];
  for (const raw of analysts ?? []) {
    const a = raw.replace(/[（(][^（()）]*[）)]/g, '').trim();
    if (!a || a === '(未知)' || a.includes('主持群')) continue;
    if (NON_TEACHER_NAMES.has(a)) continue;
    // 沒有任何中文字 = 影片 id / source_id / 英文節目代號的殘渣（如 ailun-live、6zY4J2Yl-hk），不是老師名。
    if (!hasCJK(a)) continue;
    // 丟掉「等於頻道名」的 fallback（LLM 沒指名具體老師）。
    // ⚠️ 只比對「完整 displayName / 頻道裸名」，不可用 displayName.includes(a)：
    //    單人節目常把老師名包在括號裡（「股市全芳位（李蜀芳）」），includes 會把真老師誤殺成 program_fallback。
    if (a === displayName || a === channelBare) continue;
    // 等於「任一節目」的名字 → 是節目名漏進 analysts（含 source_id 被寫成 video_id 時裸名比對失效的情況）。
    if (programNames?.has(a)) continue;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}
