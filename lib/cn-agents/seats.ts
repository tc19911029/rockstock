/**
 * 龍虎榜席位名錄（registry）載入 + 席位貼標 lookup
 *
 * 貼標優先序（lookupSeat）：
 *   1. deptCode 精確匹配（EM OPERATEDEPT_CODE；席位改名不斷檔的主鍵）
 *      — 注意 EM 把所有「机构专用」席位一律標 deptCode='0'（多家機構共用同碼），
 *        '0' 與空字串不可進精確匹配，交給內建規則
 *   2. namePattern substring 匹配（陣列序 = 優先序，先列先贏）
 *   3. 內建規則：名含「机构专用」→ institution；含「沪股通」「深股通」→ northbound；
 *      含「拉萨」→ retail_proxy（東財拉薩系導流營業部全中，免逐條列）
 *   4. 都沒中 → unknown
 *
 * registry seed 來源：公開遊資名錄整理（東財財富號 2025-01/2025-08 名錄、
 * 網易/知乎遊資席位匯總），2026-06 版。注意事項：
 *   - 綽號↔營業部是市場 lore，會隨席位遷移衰減；不確定的刻意不收（寧缺勿濫）
 *   - namePattern 盡量用「街道級」獨特字串（如「上海江苏路证券营业部」），
 *     讓券商改名/合併（國泰君安+海通→國泰海通）不影響匹配；
 *     街名太通用時（分公司/总部/淮海中路）才帶券商前綴
 *   - data/cn-agents/seats/registry.json 是使用者可手改的活檔 —
 *     loadSeatRegistry 只在檔案不存在時寫入 seed，存在就以檔案為準
 */

import type { SeatRegistryEntry, SeatRegistryFile, SeatType } from './types';
import { CN_AGENTS_SCHEMA_VERSION } from './types';

// ── 內建 registry seed（公開整理、2026-06 版） ────────────────────────────────

export const SEAT_REGISTRY_SEED: SeatRegistryEntry[] = [
  // ── 頂級游資 ──
  { namePattern: '上海江苏路证券营业部', label: '章盟主', type: 'hot_money', style: 'daban', note: '章建平主席位（国泰君安→国泰海通）；公開整理、2026-06 版' },
  { namePattern: '宁波彩虹北路', label: '章盟主', type: 'hot_money', style: 'daban', note: '公開整理、2026-06 版' },
  { namePattern: '杭州四季路', label: '章盟主', type: 'hot_money', style: 'daban', note: '中信杭州四季路；公開整理、2026-06 版' },
  { namePattern: '中信证券股份有限公司杭州延安路', label: '章盟主', type: 'hot_money', style: 'daban', note: '公開整理、2026-06 版' },
  { namePattern: '财通证券股份有限公司杭州解放东路', label: '章盟主', type: 'hot_money', style: 'daban', note: '公開整理、2026-06 版' },
  { namePattern: '银河证券股份有限公司绍兴', label: '赵老哥', type: 'hot_money', style: 'daban', note: '八年一萬倍主席位（含紹興解放北路）；公開整理、2026-06 版' },
  { namePattern: '浙商证券股份有限公司绍兴分公司', label: '赵老哥', type: 'hot_money', style: 'daban', note: '公開整理、2026-06 版' },
  { namePattern: '中信证券股份有限公司上海淮海中路', label: '赵老哥/孙哥（混用）', type: 'hot_money', style: 'daban', note: '兩路頂級游資混用席位；公開整理、2026-06 版' },
  { namePattern: '上海溧阳路', label: '孙哥', type: 'hot_money', style: 'daban', note: '孫煜主席位（中信上海溧陽路）；公開整理、2026-06 版' },
  { namePattern: '光大证券股份有限公司杭州庆春路', label: '孙哥', type: 'hot_money', style: 'daban', note: '公開整理、2026-06 版' },
  { namePattern: '兴业证券股份有限公司陕西分公司', label: '方新侠', type: 'hot_money', style: 'daban', note: '陝西系主席位；公開整理、2026-06 版' },
  { namePattern: '西安朱雀大街', label: '方新侠', type: 'hot_money', style: 'daban', note: '中信西安朱雀大街；公開整理、2026-06 版' },
  { namePattern: '西安南广济街', label: '方新侠', type: 'hot_money', style: 'daban', note: '廣發西安南廣濟街；公開整理、2026-06 版' },
  // 炒股养家（=养家心法，同一人雪球/淘股吧 ID）— 华鑫系多席位
  { namePattern: '上海红宝石路', label: '炒股养家', type: 'hot_money', style: 'banlu', note: '=养家心法；華鑫上海紅寶石路；公開整理、2026-06 版' },
  { namePattern: '宛平南路', label: '炒股养家', type: 'hot_money', style: 'banlu', note: '=养家心法；華鑫宛平南路（量化亦常借道，混用）；公開整理、2026-06 版' },
  { namePattern: '宁波沧海路', label: '炒股养家', type: 'hot_money', style: 'banlu', note: '=养家心法；公開整理、2026-06 版' },
  { namePattern: '上海茅台路', label: '炒股养家', type: 'hot_money', style: 'banlu', note: '=养家心法；公開整理、2026-06 版' },
  { namePattern: '华鑫证券有限责任公司江苏分公司', label: '炒股养家', type: 'hot_money', style: 'banlu', note: '=养家心法；公開整理、2026-06 版' },
  // ── 新生代游資 ──
  { namePattern: '南京大钟亭', label: '小鳄鱼', type: 'hot_money', style: 'daban', note: '南京證券南京大鐘亭；公開整理、2026-06 版' },
  { namePattern: '中金财富证券有限公司南京太平南路', label: '小鳄鱼', type: 'hot_money', style: 'daban', note: '原中投證券南京太平南路；公開整理、2026-06 版' },
  { namePattern: '上海兰花路', label: '小鳄鱼', type: 'hot_money', style: 'daban', note: '天風上海蘭花路；公開整理、2026-06 版' },
  { namePattern: '国泰君安证券股份有限公司南京太平南路', label: '作手新一', type: 'hot_money', style: 'daban', note: '舊名（合併前）；公開整理、2026-06 版' },
  { namePattern: '国泰海通证券股份有限公司南京太平南路', label: '作手新一', type: 'hot_money', style: 'daban', note: '國泰君安+海通合併後新名；公開整理、2026-06 版' },
  { namePattern: '南京金融城', label: '作手新一', type: 'hot_money', style: 'daban', note: '公開整理、2026-06 版' },
  { namePattern: '大连金马路', label: '陈小群', type: 'hot_money', style: 'daban', note: '銀河大連金馬路；公開整理、2026-06 版' },
  { namePattern: '苏州留园路', label: '陈小群', type: 'hot_money', style: 'daban', note: '東亞前海蘇州留園路；公開整理、2026-06 版' },
  { namePattern: '南京天元东路', label: '92科比', type: 'hot_money', style: 'daban', note: '興業南京天元東路；公開整理、2026-06 版' },
  { namePattern: '东直门南大街', label: '北京炒家', type: 'hot_money', style: 'daban', note: '中信建投北京東直門南大街；公開整理、2026-06 版' },
  { namePattern: '北京阜外大街', label: '著名刺客', type: 'hot_money', style: 'daban', note: '海通→國泰海通北京阜外大街（街名匹配跨改名）；公開整理、2026-06 版' },
  { namePattern: '东莞证券股份有限公司北京分公司', label: '著名刺客', type: 'hot_money', style: 'daban', note: '公開整理、2026-06 版' },
  { namePattern: '国泰君安证券股份有限公司上海分公司', label: '葛老大', type: 'hot_money', style: 'swing', note: '舊名（合併前）；公開整理、2026-06 版' },
  { namePattern: '国泰海通证券股份有限公司上海分公司', label: '葛老大', type: 'hot_money', style: 'swing', note: '合併後新名；公開整理、2026-06 版' },
  // ── 知名席位（綽號=席位本身 / 幫派系） ──
  { namePattern: '佛山绿景路', label: '佛山无影脚', type: 'hot_money', style: 'daban', note: '光大佛山綠景路；公開整理、2026-06 版' },
  { namePattern: '佛山季华六路', label: '佛山无影脚', type: 'hot_money', style: 'daban', note: '公開整理、2026-06 版' },
  { namePattern: '宁波桑田路', label: '宁波桑田路', type: 'hot_money', style: 'daban', note: '國盛寧波桑田路；公開整理、2026-06 版' },
  { namePattern: '深圳欢乐海岸', label: '欢乐海岸', type: 'hot_money', style: 'daban', note: '中泰深圳歡樂海岸；公開整理、2026-06 版' },
  { namePattern: '杭州上塘路', label: '上塘路', type: 'hot_money', style: 'daban', note: '財通杭州上塘路（杭州幫）；公開整理、2026-06 版' },
  { namePattern: '深圳蛇口工业七路', label: '乔帮主', type: 'hot_money', style: 'daban', note: '招商深圳蛇口工業七路；公開整理、2026-06 版' },
  { namePattern: '深圳蛇口工业三路', label: '乔帮主', type: 'hot_money', style: 'daban', note: '公開整理、2026-06 版' },
  { namePattern: '深圳振华路', label: '深圳振华路（深圳帮）', type: 'hot_money', style: 'daban', note: '國信深圳振華路老牌敢死隊；公開整理、2026-06 版' },
  { namePattern: '益田路荣超商务中心', label: '益田路荣超（游资混用）', type: 'hot_money', style: 'daban', note: '華泰深圳益田路榮超，多路游資混用熱門席位；公開整理、2026-06 版' },
  { namePattern: '无锡清扬路', label: '无锡帮（清扬路）', type: 'hot_money', style: 'daban', note: '中金財富（原中投）無錫清揚路；公開整理、2026-06 版' },
  { namePattern: '厦门美湖路', label: '厦门帮（美湖路）', type: 'hot_money', style: 'daban', note: '銀河廈門美湖路；公開整理、2026-06 版' },
  // ── 量化大本營 ──
  { namePattern: '华鑫证券有限责任公司上海分公司', label: '量化大本营（华鑫上海分公司）', type: 'quant', style: 'T0', note: '量化 T0/打板代表席位；公開整理、2026-06 版' },
  { namePattern: '华泰证券股份有限公司总部', label: '量化通道（华泰总部）', type: 'quant', style: 'T0', note: '公開整理、2026-06 版' },
  { namePattern: '上海黄浦区湖滨路', label: '量化通道（中金湖滨路）', type: 'quant', style: 'T0', note: '中金上海黃浦區湖濱路；公開整理、2026-06 版' },
  { namePattern: '国泰君安证券股份有限公司总部', label: '量化通道（国泰君安总部）', type: 'quant', style: 'T0', note: '舊名（合併前）；公開整理、2026-06 版' },
  { namePattern: '国泰海通证券股份有限公司总部', label: '量化通道（国泰海通总部）', type: 'quant', style: 'T0', note: '合併後新名；公開整理、2026-06 版' },
  // ── 機構 / 外資通道（「机构专用」走內建規則，這裡只列具名通道） ──
  { namePattern: '中信证券股份有限公司总部（非营业场所）', label: 'QFII/机构通道（中信总部）', type: 'institution', note: '外資 QFII 經典通道；公開整理、2026-06 版' },
  { namePattern: '上海花园石桥路', label: 'QFII（瑞银上海）', type: 'institution', note: '瑞銀上海花園石橋路；公開整理、2026-06 版' },
  { namePattern: '中国国际金融股份有限公司上海淮海中路', label: 'QFII（中金淮海中路）', type: 'institution', note: '注意與中信淮海中路（游資）區分，故帶全名前綴；公開整理、2026-06 版' },
  { namePattern: '北京建国门外大街', label: 'QFII（中金建外大街）', type: 'institution', note: '中金北京建國門外大街；公開整理、2026-06 版' },
];

// ── registry 載入（seed-or-load，FS 為準） ───────────────────────────────────

/**
 * 讀 data/cn-agents/seats/registry.json；不存在（或壞檔）→ 寫入內建 seed 後回傳。
 *
 * 刻意 FS-only 不走 dual-storage：registry 是「人工 curate 的設定檔」隨 repo 部署，
 * 不是每日資料 — Vercel 上唯讀打包進 bundle 即可（寫入失敗靜默忽略，仍回 seed）。
 */
export async function loadSeatRegistry(): Promise<SeatRegistryFile> {
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const dir = path.join(process.cwd(), 'data', 'cn-agents', 'seats');
  const file = path.join(dir, 'registry.json');
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as SeatRegistryFile;
    if (Array.isArray(parsed?.seats)) return parsed;
  } catch {
    // 不存在或壞檔 → 落到 seed
  }
  const seeded: SeatRegistryFile = {
    schemaVersion: CN_AGENTS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    seats: SEAT_REGISTRY_SEED,
  };
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(seeded, null, 2), 'utf-8');
  } catch {
    // Vercel 唯讀 FS — 寫不進去沒關係，回傳記憶體 seed 即可
  }
  return seeded;
}

// ── 席位貼標 ──────────────────────────────────────────────────────────────────

/** 內建規則（registry 沒中才輪到；拉薩/機構/北向免逐條列） */
function builtinLookup(deptName: string): { type: SeatType; label: string | null } | null {
  if (deptName.includes('机构专用')) return { type: 'institution', label: null };
  if (deptName.includes('沪股通') || deptName.includes('深股通')) return { type: 'northbound', label: null };
  if (deptName.includes('拉萨')) return { type: 'retail_proxy', label: '拉萨军团（东财）' };
  return null;
}

/**
 * 席位貼標：deptCode 精確 → namePattern substring（陣列序優先）→ 內建規則 → unknown。
 * 純函式（registry 由呼叫端先 loadSeatRegistry 一次，迴圈內重用）。
 */
export function lookupSeat(
  deptCode: string,
  deptName: string,
  registry: SeatRegistryFile,
): { type: SeatType; label: string | null } {
  // 1) deptCode 精確匹配（'0' = EM 對「机构专用」的共用碼，多家機構撞同碼，不可當主鍵）
  if (deptCode && deptCode !== '0') {
    const codeHit = registry.seats.find((s) => s.deptCode && s.deptCode === deptCode);
    if (codeHit) return { type: codeHit.type, label: codeHit.label };
  }
  // 2) namePattern substring（先列先贏）
  if (deptName) {
    const nameHit = registry.seats.find((s) => s.namePattern && deptName.includes(s.namePattern));
    if (nameHit) return { type: nameHit.type, label: nameHit.label };
    // 3) 內建規則
    const builtin = builtinLookup(deptName);
    if (builtin) return builtin;
  }
  // 4) 沒中
  return { type: 'unknown', label: null };
}
