/**
 * 老師（分析師）顯示名清洗 — 從 YoutubeProgramStocks 抽出共用，
 * 讓「節目卡顯示」與「推薦事件抽取（recoEvents）」吃同一套規則。
 *
 * 例：「高獻榮(金臨天下)」→「高獻榮」、「智霖(錢線百分百)」→「智霖」；
 * 丟掉等於節目名 / (未知) / 主持群 的 fallback（代表 LLM 沒指名具體老師）。
 */
export function cleanTeacherNames(analysts: string[] | undefined, displayName: string): string[] {
  // 頻道裸名 = displayName 去掉括號（「決勝關鍵（每日台股解盤）」→「決勝關鍵」）。
  const channelBare = displayName.replace(/[（(][^（()）]*[）)]/g, '').trim();
  const out: string[] = [];
  for (const raw of analysts ?? []) {
    const a = raw.replace(/[（(][^（()）]*[）)]/g, '').trim();
    if (!a || a === '(未知)' || a.includes('主持群')) continue;
    // 丟掉「等於頻道名」的 fallback（LLM 沒指名具體老師）。
    // ⚠️ 只比對「完整 displayName / 頻道裸名」，不可用 displayName.includes(a)：
    //    單人節目常把老師名包在括號裡（「股市全芳位（李蜀芳）」），includes 會把真老師誤殺成 program_fallback。
    if (a === displayName || a === channelBare) continue;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}
