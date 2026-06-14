/**
 * 臨時查詢：指定題材的「題材∩三色」命中股 + 命中哪些具名策略。
 * 用法：npx tsx scripts/show-theme-sanse-picks.ts [TW] [date] [題材1,題材2]
 */
import { selectForDate } from '@/lib/theme-sanse/events';
import type { TsMarket } from '@/lib/theme-sanse/types';

const market = (process.argv[2] || 'TW') as TsMarket;
const date = process.argv[3] || '2026-06-12';
const themeFilter = (process.argv[4] || '被動元件,金融').split(',');

const labelOf = (ns: unknown): string => {
  if (Array.isArray(ns)) return ns.map((x: any) => (typeof x === 'string' ? x : x?.label ?? x?.id ?? '')).filter(Boolean).join(' / ');
  return '';
};

async function main() {
  const sel = await selectForDate(market, date);
  console.log(`${market} ${date}｜三色掃描 ${sel.sanseUniverse} 檔｜熱題材 ${sel.hotThemes.length} 個`);
  const cross = sel.selection.cross || [];
  console.log(`題材∩三色 cross 命中總數 ${cross.length}\n`);

  for (const theme of themeFilter) {
    const hits = cross.filter((c: any) => (c.themes || []).some((t: any) => (t.themeName || t.theme) === theme));
    console.log(`── 【${theme}】命中 ${hits.length} 檔 ──`);
    if (hits.length === 0) { console.log('  （無命中）\n'); continue; }
    for (const c of hits) {
      const ns = labelOf(c.namedStrategies);
      const good = /底反|紅\+黃\+觸發/.test(ns) ? '⭐可用' : '';
      console.log(`  ${(c.name || c.code).padEnd(8)} ${c.code}  策略[${ns || '—'}]  狀態=${c.sanseState ?? '—'} 評語=${c.verdict ?? '—'} 題材名次#${c.bestThemeRank ?? '?'} ${good}`);
    }
    console.log('');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
