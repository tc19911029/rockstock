/**
 * 老簡「內部大戶」回測 — 大戶級距增加、但剔除法人貢獻後，非法人大戶在買到底有沒有 edge？
 *
 * 出處：理財資優生 EP75（2026-05-18）老簡（簡之隊）：
 *   內部大戶 = 集保股權分散表的大戶 − 法人大戶。門檻用金額（基準約2000萬）分層：
 *   股價≥1000 看100張級距、≥50 看400張、20~50 看1000張。
 *   他宣稱非法人大戶績效遠勝法人（知道內情）。基本面為盾（營收創新高+毛利成長）、籌碼為矛。
 *
 * 實作 proxy：
 *   Δ大戶% = 該股當週 TDCC 級距持股% 變化（老簡分層）
 *   法人週Δ% = 該 TDCC 週內三大法人合計買賣超(張)×1000 ÷ 發行股數 ×100
 *   內部大戶Δ% = Δ大戶% − 法人週Δ%   →  >0 = 非法人大戶在增持
 *   毛利率歷史無快取 → 用「月營收創12個月新高」近似基本面盾（announce 延遲到次月10日防前視）。
 *
 * 防過擬合 + 誠實 edge（同 backtest-chen-weitai-chips 底座）：
 *   週度事件（一檔一週一筆，TDCC 週五資料、次交易日開盤進場）、液態 top500、
 *   超額對 ^TWII、時間中位切 train/test。train+test 都正且 test 勝率≥50% 才算真有料。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const TDCC = path.join(process.cwd(), 'data/chips/TW/tdcc');
const SHARE = path.join(process.cwd(), 'data/_finmind/shareholding');
const REV = path.join(process.cwd(), 'data/_finmind/revenue');
const FROM = '2024-01-05'; // TDCC 2023-10-20 起，留 ~10 週 consec 暖機
const HORIZONS = [5, 10, 20, 60, 120] as const; // 120 ≈ 老簡 APP 宣稱的「半年後無腦賣」
const PRIMARY = 20;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Ev {
  date: string;                    // TDCC 資料日（週五）
  turnover: number;                // 流動性排名用
  ret: Record<number, number>; excess: Record<number, number>;
  holderChg: number;               // Δ大戶%（老簡分層）
  instPct: number | null;          // 法人週Δ%（缺股本→null）
  insiderD: number | null;         // 內部大戶Δ%
  insiderConsec: number;           // 內部大戶Δ% 連續>0 週數（含本週）
  ma60up: boolean;
  revNewHigh: boolean | null;      // 最新已公告月營收=近12月新高（歷史<12月→null）
  avgVol20: number;                // 20日均量(張)：APP 熱門/冷門分界 1000 張
  issuedChanged: boolean;          // 該週股本變動（增資/可轉債）→ APP 直接剔除
  cumNewHigh: boolean;             // 內部大戶累積買超% 創資料期新高（零軸曲線創高）
}

async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function sgn(x: number) { return (x >= 0 ? '+' : '') + x.toFixed(2) + '%'; }

function agg(rows: Ev[], h: number) {
  if (rows.length === 0) return { ex: 0, win: 0, raw: 0, n: 0 };
  const ex = rows.reduce((s, r) => s + r.excess[h], 0) / rows.length;
  const raw = rows.reduce((s, r) => s + r.ret[h], 0) / rows.length;
  const win = 100 * rows.filter(r => r.excess[h] > 0).length / rows.length;
  return { ex, win, raw, n: rows.length };
}

/** 老簡金額分層：≥1000元看100張、≥50看400張、20~50看1000張、<20 不看 */
function tierKey(px: number): 'holder100Pct' | 'holder400Pct' | 'holder1000Pct' | null {
  if (px >= 1000) return 'holder100Pct';
  if (px >= 50) return 'holder400Pct';
  if (px >= 20) return 'holder1000Pct';
  return null;
}

async function main() {
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };

  // ── 股本：shareholding 檔日期列表，per TDCC 週 lazy load 最近 ≤date 的一天 ──
  const shareDates = (await fs.readdir(SHARE)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
  const shareCache = new Map<string, Map<string, number>>();
  async function sharesAt(date: string): Promise<Map<string, number> | null> {
    let pick: string | null = null;
    for (let i = shareDates.length - 1; i >= 0; i--) { if (shareDates[i] <= date) { pick = shareDates[i]; break; } }
    if (!pick) return null;
    if (shareCache.has(pick)) return shareCache.get(pick)!;
    const j = await readJ(path.join(SHARE, pick + '.json'));
    const m = new Map<string, number>();
    for (const r of (j?.rows || [])) { if (r.stock_id && r.NumberOfSharesIssued > 0) m.set(r.stock_id, r.NumberOfSharesIssued); }
    shareCache.set(pick, m);
    return m;
  }

  // ── 月營收：code → 升冪 [{known, rev}]，known = 營收月次月10日（防前視）──
  const revMap = new Map<string, { known: string; rev: number }[]>();
  for (const f of (await fs.readdir(REV)).filter(f => /^\d{4}-\d{2}\.json$/.test(f))) {
    const j = await readJ(path.join(REV, f));
    for (const r of (j?.rows || [])) {
      if (!r.stock_id || !(r.revenue > 0) || !r.revenue_year || !r.revenue_month) continue;
      const ny = r.revenue_month === 12 ? r.revenue_year + 1 : r.revenue_year;
      const nm = r.revenue_month === 12 ? 1 : r.revenue_month + 1;
      const known = `${ny}-${String(nm).padStart(2, '0')}-10`;
      (revMap.get(r.stock_id) ?? revMap.set(r.stock_id, []).get(r.stock_id)!).push({ known, rev: r.revenue });
    }
  }
  for (const arr of revMap.values()) arr.sort((a, b) => a.known < b.known ? -1 : 1);
  /** 最新已公告月營收是否為近12個月(已公告)新高；不足12月 → null */
  function revNewHighAt(code: string, date: string): boolean | null {
    const arr = revMap.get(code); if (!arr) return null;
    let last = -1;
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].known <= date) { last = i; break; } }
    if (last < 11) return null;
    const cur = arr[last].rev;
    for (let i = last - 11; i < last; i++) { if (arr[i].rev >= cur) return false; }
    return true;
  }

  const files = (await fs.readdir(TDCC)).filter(f => /^\d{4}\.json$/.test(f)); // 4碼純個股，排除ETF
  const all: Ev[] = [];
  let noShares = 0, done = 0;

  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = (await readJ(path.join(C, `${code}.TW.json`))) ?? (await readJ(path.join(C, `${code}.TWO.json`)));
    if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0);
    if (cs.length < 80) continue;
    const [ins, tj] = await Promise.all([readJ(path.join(INST, f)), readJ(path.join(TDCC, f))]);
    const instByDate = new Map<string, number>();
    for (const d of (ins?.data || [])) instByDate.set(d.date, d.total ?? 0);
    const rows = (tj?.data || []).filter((r: any) => r && r.date).sort((a: any, b: any) => a.date < b.date ? -1 : 1);
    if (rows.length < 3) continue;

    const cd = cs.map(c => c.date);
    const cAt = (d: string) => { let lo = 0, hi = cd.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (cd[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
    const close = cs.map(c => c.close);
    const ma = (t: number, n: number) => { let s = 0; for (let j = t - n + 1; j <= t; j++) s += close[j]; return s / n; };

    // 每週 insiderD 序列（供 consec），與事件同步生成；cum = 零軸累積曲線
    const weekly: { date: string; insiderD: number | null; ev: Ev | null }[] = [];
    let cum = 0, cumMax = 0;

    for (let i = 1; i < rows.length; i++) {
      const dt = rows[i].date as string, prev = rows[i - 1].date as string;
      const t = cAt(dt);
      if (t < 60) { weekly.push({ date: dt, insiderD: null, ev: null }); continue; }
      const px = close[t];
      const key = tierKey(px);
      const cur = key ? rows[i][key] : null, pre = key ? rows[i - 1][key] : null;
      if (key == null || cur == null || pre == null) { weekly.push({ date: dt, insiderD: null, ev: null }); continue; }
      const holderChg = cur - pre;

      // 法人該 TDCC 週買賣超合計（張）→ Δ%
      let instSum = 0, instDays = 0;
      for (let k = t; k >= 0 && cs[k].date > prev; k--) {
        if (instByDate.has(cs[k].date)) { instSum += instByDate.get(cs[k].date)!; instDays++; }
      }
      const shares = await sharesAt(dt);
      const issued = shares?.get(code);
      const instPct = (issued && instDays > 0) ? (instSum * 1000 / issued) * 100 : null;
      if (instPct == null) noShares++;
      const insiderD = instPct != null ? holderChg - instPct : null;
      // 股本變動（APP 直接剔除）：與前一週發行股數差 >0.1%
      const sharesPrev = await sharesAt(prev);
      const issuedPrev = sharesPrev?.get(code);
      const issuedChanged = !!(issued && issuedPrev && Math.abs(issued / issuedPrev - 1) > 0.001);
      // 零軸累積曲線創新高（累積買超%破前高且本週為正）
      if (insiderD != null) cum += insiderD;
      const cumNewHigh = insiderD != null && insiderD > 0 && cum > cumMax + 1e-9;
      if (cum > cumMax) cumMax = cum;

      // 事件報酬：次交易日開盤進場
      if (dt < FROM || t + 2 >= cs.length || !(cs[t + 1].open > 0)) { weekly.push({ date: dt, insiderD, ev: null }); continue; }
      const e = twAt(cs[t + 1].date);
      if (e < 0) { weekly.push({ date: dt, insiderD, ev: null }); continue; }
      const ret: Record<number, number> = {}, excess: Record<number, number> = {};
      let bad = false;
      for (const h of HORIZONS) {
        const xi = Math.min(t + 1 + h, cs.length - 1);
        const r = (cs[xi].close / cs[t + 1].open - 1) * 100;
        if (Math.abs(r) > 80) { bad = true; break; }
        const x = twAt(cs[xi].date);
        const mkt = (x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
        ret[h] = r; excess[h] = r - mkt;
      }
      if (bad) { weekly.push({ date: dt, insiderD, ev: null }); continue; }

      let v20 = 0; for (let kk = t - 19; kk <= t; kk++) v20 += cs[kk].volume;
      const ev: Ev = {
        date: dt, turnover: px * (v20 / 20),
        ret, excess, holderChg, instPct, insiderD,
        insiderConsec: 0, // 下面補
        ma60up: px > ma(t, 60),
        revNewHigh: revNewHighAt(code, dt),
        avgVol20: v20 / 20,
        issuedChanged,
        cumNewHigh,
      };
      weekly.push({ date: dt, insiderD, ev });
    }

    // 補 insiderConsec：連續 >0 週數（含本週）
    for (let i = 0; i < weekly.length; i++) {
      if (!weekly[i].ev) continue;
      let cnt = 0;
      for (let k = i; k >= 0; k--) { if (weekly[k].insiderD != null && weekly[k].insiderD! > 0) cnt++; else break; }
      weekly[i].ev!.insiderConsec = cnt;
      all.push(weekly[i].ev!);
    }
    if (++done % 500 === 0) console.error(`…${done} 檔處理完`);
  }

  // 週度液態 top500
  const byW = new Map<string, Ev[]>();
  for (const r of all) { (byW.get(r.date) ?? byW.set(r.date, []).get(r.date)!).push(r); }
  const liq: Ev[] = [];
  for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  const mid = liq[Math.floor(liq.length / 2)].date;
  const train = liq.filter(r => r.date < mid), test = liq.filter(r => r.date >= mid);
  console.log(`液態樣本 ${liq.length} 筆（週度事件）| train ${train.length}（${liq[0].date}~）| test ${test.length}（${mid}~${liq[liq.length - 1].date}）`);
  console.log(`法人Δ%缺值（無股本/無法人資料）事件數：${noShares}\n`);

  type V = { name: string; pred: (r: Ev) => boolean };
  const variants: V[] = [
    { name: '基準：全液態股', pred: () => true },
    { name: '大戶單週增>0.1（S軌基準,已知弱）', pred: r => r.holderChg > 0.1 },
    { name: '★內部大戶Δ>0.1（剔除法人）', pred: r => r.insiderD != null && r.insiderD > 0.1 },
    { name: '★內部大戶Δ>0.3（強訊號）', pred: r => r.insiderD != null && r.insiderD > 0.3 },
    { name: '★內部大戶Δ>0.1 且法人沒買', pred: r => r.insiderD != null && r.insiderD > 0.1 && r.instPct != null && r.instPct <= 0 },
    { name: '★內部大戶 連2週+', pred: r => r.insiderConsec >= 2 },
    { name: '★內部大戶 連3週+', pred: r => r.insiderConsec >= 3 },
    { name: '★內部大戶Δ>0.1 +站上季線', pred: r => r.insiderD != null && r.insiderD > 0.1 && r.ma60up },
    { name: '★老簡全法:內部大戶+營收12月新高', pred: r => r.insiderD != null && r.insiderD > 0.1 && r.revNewHigh === true },
    { name: '對照:大戶增但其實是法人(insider≤0)', pred: r => r.holderChg > 0.1 && r.insiderD != null && r.insiderD <= 0 },
    { name: '對照:營收12月新高(單獨)', pred: r => r.revNewHigh === true },
    { name: '🚫避雷:內部大戶Δ<-0.3(在跑)', pred: r => r.insiderD != null && r.insiderD < -0.3 },
    { name: '🚫避雷:內部大戶跑+法人在買(接刀掩護)', pred: r => r.insiderD != null && r.insiderD < -0.3 && r.instPct != null && r.instPct > 0 },
  ];

  console.log(`========== 老簡「內部大戶」ablation（持有${PRIMARY}日，超額對^TWII）==========`);
  console.log('變體                                      train超額/勝率 → test超額/勝率   (train/test筆數)  raw報酬(test)');
  for (const v of variants) {
    const tr = agg(train.filter(v.pred), PRIMARY), te = agg(test.filter(v.pred), PRIMARY);
    const verdict = tr.ex > 0 && te.ex > 0 && te.win >= 50 ? '  ✅真有料'
      : tr.ex < 0 && te.ex < 0 ? '  🚫兩期都負' : '  ⚠️不穩';
    console.log(`  ${v.name.padEnd(34)} ${sgn(tr.ex)}/${tr.win.toFixed(0)}% → ${sgn(te.ex)}/${te.win.toFixed(0)}%   (${tr.n}/${te.n})  raw ${sgn(te.raw)}${verdict}`);
  }

  console.log('\n========== 核心變體 各持有天數（內部大戶Δ>0.1）==========');
  const core = (r: Ev) => r.insiderD != null && r.insiderD > 0.1;
  console.log('持有天數    train超額/勝率 → test超額/勝率   raw報酬(test)');
  for (const h of HORIZONS) {
    const tr = agg(train.filter(core), h), te = agg(test.filter(core), h);
    console.log(`  d${String(h).padEnd(3)}     ${sgn(tr.ex)}/${tr.win.toFixed(0)}% → ${sgn(te.ex)}/${te.win.toFixed(0)}%    raw ${sgn(te.raw)}  (n=${te.n})`);
  }

  console.log('\n========== 老簡全法（內部大戶+營收新高）各持有天數 ==========');
  const full = (r: Ev) => r.insiderD != null && r.insiderD > 0.1 && r.revNewHigh === true;
  for (const h of HORIZONS) {
    const tr = agg(train.filter(full), h), te = agg(test.filter(full), h);
    console.log(`  d${String(h).padEnd(3)}     ${sgn(tr.ex)}/${tr.win.toFixed(0)}% → ${sgn(te.ex)}/${te.win.toFixed(0)}%    raw ${sgn(te.raw)}  (n=${te.n})`);
  }

  // ── APP 忠實參數版：老簡 APP 的實際用法（非液態 top500，他專打中小/冷門股）──
  // 宇宙 = 日均量 ≥100 張（他說「太冷不選」）、剔除股本變動週（APP 直接剔除）、insiderΔ 可算
  const appUni = all.filter(r => r.avgVol20 >= 100 && !r.issuedChanged && r.insiderD != null);
  const aTrain = appUni.filter(r => r.date < mid), aTest = appUni.filter(r => r.date >= mid);
  console.log(`\n========== APP 忠實參數版（宇宙=日均量≥100張+剔股權變化；報買=買超>股本2%）==========`);
  console.log(`樣本 train ${aTrain.length} / test ${aTest.length}（同一時間切點 ${mid}）`);
  const appVariants: V[] = [
    { name: '基準:該宇宙全體', pred: () => true },
    { name: '★報買:insiderΔ>2%', pred: r => r.insiderD! > 2 },
    { name: '★報買+冷門股(<1000張)', pred: r => r.insiderD! > 2 && r.avgVol20 < 1000 },
    { name: '★報買+熱門股(≥1000張)', pred: r => r.insiderD! > 2 && r.avgVol20 >= 1000 },
    { name: '★報買+月營收12月新高', pred: r => r.insiderD! > 2 && r.revNewHigh === true },
    { name: '★累積創新高(零軸曲線破前高)', pred: r => r.cumNewHigh },
    { name: '★累積創新高+報買', pred: r => r.cumNewHigh && r.insiderD! > 2 },
  ];
  console.log('變體                                      train超額/勝率 → test超額/勝率   (train/test筆數)  raw報酬(test)');
  for (const v of appVariants) {
    const tr = agg(aTrain.filter(v.pred), PRIMARY), te = agg(aTest.filter(v.pred), PRIMARY);
    const verdict = tr.ex > 0 && te.ex > 0 && te.win >= 50 ? '  ✅真有料'
      : tr.ex < 0 && te.ex < 0 ? '  🚫兩期都負' : '  ⚠️不穩';
    console.log(`  ${v.name.padEnd(34)} ${sgn(tr.ex)}/${tr.win.toFixed(0)}% → ${sgn(te.ex)}/${te.win.toFixed(0)}%   (${tr.n}/${te.n})  raw ${sgn(te.raw)}${verdict}`);
  }

  console.log('\n========== 報買(insiderΔ>2%) 各持有天數（APP 宣稱 3-6 個月無腦賣平均+14%）==========');
  const baomai = (r: Ev) => r.insiderD! > 2;
  console.log('持有天數    train超額/勝率 → test超額/勝率   raw報酬(train / test)');
  for (const h of HORIZONS) {
    const tr = agg(aTrain.filter(baomai), h), te = agg(aTest.filter(baomai), h);
    console.log(`  d${String(h).padEnd(3)}     ${sgn(tr.ex)}/${tr.win.toFixed(0)}% → ${sgn(te.ex)}/${te.win.toFixed(0)}%    raw ${sgn(tr.raw)} / ${sgn(te.raw)}  (n=${tr.n}/${te.n})`);
  }

  console.log('\n判讀準則：');
  console.log('  真有料 = train+test 超額都正 且 test 勝率≥50%。raw 高但 excess≈0/負 = 吃大盤beta。');
  console.log('  ⚠️ 毛利率無歷史快取未納入；法人Δ%用買賣超流量近似（老簡 APP 另有壽險/非大戶法人私有參數）。');
  console.log('  ⚠️ d120 對近期事件會被截斷在最新收盤（持有不足 120 日），train 段完整。');
}
main().catch(e => { console.error(e); process.exit(1); });
