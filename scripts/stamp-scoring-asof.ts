/**
 * stamp-scoring-asof — 標記「評分用的是事後行情」的分析日（前視污染揭露）
 *
 * 用法：
 *   npx tsx scripts/stamp-scoring-asof.ts            # 掃全部，只報告
 *   npx tsx scripts/stamp-scoring-asof.ts --write    # 掃全部並回填 scoring_data_asof
 *   npx tsx scripts/stamp-scoring-asof.ts 2026-07-13 --write
 *
 * 背景：/youtube-analysis 的 9 維評分是打本機 internal API 拿「最新收盤」。當晚 23:55 跑
 * 沒問題（最新收盤=當日），但**補跑**時抓到的是補跑當下的行情 — 2026-07-15 補跑 07-13，
 * 42 檔評分全用 07-15 的收盤算。分數/評級因此含前視，不可拿來評估「當天選不選得出來」。
 *
 * 判準只認事實：掃 factor_evidence 內實際出現的行情日期，取最大值；> 分析日 → 蓋章。
 * 不用 generated_at 推測（nightly 拖過午夜會誤判成補跑）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'data', 'youtube', 'analysis');
const args = process.argv.slice(2);
const write = args.includes('--write');
const only = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

async function main() {
  const files = (await fs.readdir(DIR))
    .filter(f => f.endsWith('.json'))
    .filter(f => !only || f === `${only}.json`)
    .sort();

  let stamped = 0;
  for (const f of files) {
    const p = path.join(DIR, f);
    const date = f.replace('.json', '');
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(await fs.readFile(p, 'utf-8'));
    } catch {
      console.log(`⚠️  ${date} 解析失敗，跳過`);
      continue;
    }
    const scoring = (j.stock_scoring as unknown[]) ?? [];
    if (scoring.length === 0) continue;

    // factor_evidence 內實際引用到的行情日期
    const dates = new Set<string>();
    JSON.stringify(scoring).replace(/"date":"(\d{4}-\d{2}-\d{2})"/g, (_m, d: string) => {
      dates.add(d);
      return _m;
    });
    const future = [...dates].filter(d => d > date).sort();
    if (future.length === 0) {
      if (j.scoring_data_asof) console.log(`ℹ️  ${date} 已無前視但仍有舊章（未處理，請人工確認）`);
      continue;
    }

    const asof = future[future.length - 1];
    if (j.scoring_data_asof === asof) {
      console.log(`✔  ${date} 已標記（評分資料 as-of ${asof}）`);
      continue;
    }
    console.log(`${write ? '✅ 蓋章' : '⚠️ 待蓋章'} ${date}：${scoring.length} 檔評分引用到 ${future.join(',')} 的行情 → as-of ${asof}`);
    stamped += 1;
    if (write) {
      j.scoring_data_asof = asof;
      await fs.writeFile(p, `${JSON.stringify(j, null, 2)}\n`, 'utf-8');
    }
  }

  console.log(`\n[stamp-scoring-asof] ${write ? '已蓋章' : '待蓋章'} ${stamped} 天`);
  if (!write && stamped > 0) console.log('→ 加 --write 實際回填');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
