/**
 * 一次性匯入：在持倉新增 profile「小可愛ETF」+ 4 檔場外基金（浦發銀行 App 快照 2026-06-05）
 *
 * 資料來源：使用者提供的銀行 App 截圖（市值 + 持倉收益 + 當日收益）。
 * 缺的欄位（份額 / 平均成本淨值）由「市值、持倉收益、當日單位淨值」反推：
 *   本金       = 市值 − 持倉收益
 *   份額(shares) = 市值 ÷ 淨值
 *   成本淨值     = 本金 ÷ 份額
 *
 * 淨值（dwjz）取自天天基金 2026-06-05 定盤（019671 港股創新藥 QDII 無估值，走歷史淨值 API）。
 * 之後 App 內市值會由 /api/portfolio/quotes 的 .OF 基金淨值分支即時更新。
 *
 * 冪等：profile 依名稱找不到才建立；holding 依 symbol upsert。可重跑。
 *
 * 跑法：npx tsx scripts/import-xiaokeai-etf.ts
 */

import { loadProfiles, createProfile } from '@/lib/portfolio/profiles';
import { upsertHolding } from '@/lib/agents/portfolio/storage';

const PROFILE_NAME = '小可愛ETF';
const SNAPSHOT_DATE = '2026-06-05';

interface FundSnapshot {
  code: string;
  name: string;
  nav: number;        // 當日單位淨值（dwjz）
  navDate: string;
  marketValue: number; // 市值
  holdingPnl: number;  // 持倉收益（未實現）
  dailyPnl: number;    // 當日收益
}

const FUNDS: FundSnapshot[] = [
  { code: '000217', name: '華安黃金ETF聯接C',            nav: 3.2852, navDate: '2026-06-05', marketValue: 334968.00, holdingPnl: 36988.77, dailyPnl: 479.05 },
  { code: '019671', name: '廣發港股創新藥ETF聯接(QDII)C', nav: 1.0830, navDate: '2026-06-05', marketValue: 79814.21,  holdingPnl: -20185.08, dailyPnl: -875.08 },
  { code: '019917', name: '富國醫藥創新股票C',            nav: 1.3750, navDate: '2026-06-05', marketValue: 79586.35,  holdingPnl: -20415.53, dailyPnl: -769.86 },
  { code: '009505', name: '富國上海金ETF聯接C',          nav: 2.0402, navDate: '2026-06-05', marketValue: 77848.51,  holdingPnl: -2151.48, dailyPnl: -19.01 },
];

async function resolveProfileId(): Promise<string> {
  const { profiles } = await loadProfiles();
  const existing = profiles.find(p => p.name === PROFILE_NAME);
  if (existing) {
    console.log(`profile「${PROFILE_NAME}」已存在 → ${existing.id}（沿用）`);
    return existing.id;
  }
  const created = await createProfile(PROFILE_NAME);
  console.log(`已建立 profile「${PROFILE_NAME}」→ ${created.id}`);
  return created.id;
}

async function main() {
  const profileId = await resolveProfileId();

  for (const f of FUNDS) {
    const cost = +(f.marketValue - f.holdingPnl).toFixed(2);     // 本金
    const shares = +(f.marketValue / f.nav).toFixed(2);          // 份額
    const costNav = +(cost / shares).toFixed(6);                 // 平均成本淨值
    const symbol = `${f.code}.OF`;

    await upsertHolding(
      {
        symbol,
        name: f.name,
        market: 'CN',
        entryDate: SNAPSHOT_DATE,
        entryPrice: costNav,
        shares,
        status: 'open',
        notes: `基金持倉快照（浦發銀行 App ${SNAPSHOT_DATE}）：市值 ¥${f.marketValue.toLocaleString()} / 持倉收益 ${f.holdingPnl >= 0 ? '+' : ''}¥${f.holdingPnl.toLocaleString()}。成本與份額由市值・收益・淨值反推。`,
        ui: {
          fund: true,
          fundCode: f.code,
          navAtSnapshot: f.nav,
          navDate: f.navDate,
          snapshotDate: SNAPSHOT_DATE,
          snapshotSource: '浦發銀行 App',
          marketValueSnapshot: f.marketValue,
          holdingPnlSnapshot: f.holdingPnl,
          dailyPnlSnapshot: f.dailyPnl,
        },
      },
      profileId,
    );

    console.log(
      `  ✓ ${symbol} ${f.name}｜份額 ${shares.toLocaleString()}｜成本淨值 ${costNav}｜現淨值 ${f.nav}(${f.navDate})｜` +
      `市值核對 ¥${(shares * f.nav).toFixed(2)}（App ¥${f.marketValue}）`,
    );
  }

  console.log(`\n完成：${FUNDS.length} 檔基金寫入 profile ${profileId}`);
}

main().catch(e => { console.error(e); process.exit(1); });
