/**
 * 徐黎芳「真正方法」回測 — 用主力券商分點集中度（FinMind Sponsor 灌的正版資料）
 *   5日集中度(主力分點) ≈ Σ近5日(前15買-前15賣,張) ÷ Σ近5日成交量(張) ×100%
 *   測：①招牌版 跌+主力集中度高 ②增幅排行版 ③逐步疊完整配方
 *   進場隔日開盤、持有5日、算贏大盤(^TWII)。用排名(scale-robust)+固定門檻雙軌。
 */
import { promises as fs } from 'fs';
import path from 'path';

const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const FWD = 5;

interface OHLC { date: string; open: number; close: number; volume: number }
interface Obs { conc: number; zfPP: number; redStreak: number; dip5: number; ret: number; excess: number }

function stat(label: string, rows: Obs[]) {
  if (rows.length < 5) { console.log(`  ${label.padEnd(28)} ${rows.length}筆(太少)`); return; }
  const n = rows.length;
  const avg = rows.reduce((s, r) => s + r.ret, 0) / n;
  const win = 100 * rows.filter(r => r.ret > 0).length / n;
  const exc = rows.reduce((s, r) => s + r.excess, 0) / n;
  const winM = 100 * rows.filter(r => r.excess > 0).length / n;
  console.log(`  ${label.padEnd(28)} ${String(n).padStart(5)}筆 | 報酬${avg>=0?'+':''}${avg.toFixed(2)}% | 勝${win.toFixed(0)}% | 超額${exc>=0?'+':''}${exc.toFixed(2)}% | 贏大盤${winM.toFixed(0)}%`);
}
function topFrac(rows: Obs[], key: (o: Obs) => number, frac: number) {
  return [...rows].sort((a, b) => key(b) - key(a)).slice(0, Math.max(5, Math.floor(rows.length * frac)));
}

async function main() {
  const files = (await fs.readdir(BROKER_DIR).catch(() => [])).filter(f => /^\d{4}\.json$/.test(f));
  if (!files.length) { console.log('還沒有主力分點資料'); return; }
  const twii: OHLC[] = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, '^TWII.json'), 'utf8')).candles;
  const td = twii.map(c => c.date);
  const twIdx = (d: string) => { let lo=0,hi=td.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(td[m]<=d){a=m;lo=m+1}else hi=m-1} return a; };

  const rows: Obs[] = [];
  let stocks = 0, minD='9999', maxD='0';

  for (const f of files) {
    const code = f.replace('.json', '');
    let bk: any, cdl: any;
    try { bk=JSON.parse(await fs.readFile(path.join(BROKER_DIR,f),'utf8')); cdl=JSON.parse(await fs.readFile(path.join(CANDLE_DIR,`${code}.TW.json`),'utf8')); } catch { continue; }
    const bd: {date:string;netDifference:number;concentration:number}[] = bk.data||[];
    if (bd.length < 20) continue;
    const concByDate=new Map<string,number>(), netByDate=new Map<string,number>();
    for (const d of bd){ concByDate.set(d.date,d.concentration); netByDate.set(d.date,d.netDifference); }
    const cs: OHLC[] = (cdl.candles||[]).filter((c:OHLC)=>c.close>0);
    if (cs.length<30) continue;
    stocks++;

    // 5日集中度(主力) ≈ Σ前15淨差(張) / Σ量(張)。需 5 日都有分點資料
    const conc5=(t:number):number|null=>{let net=0,vol=0;for(let k=t-4;k<=t;k++){if(!netByDate.has(cs[k].date))return null;net+=netByDate.get(cs[k].date)!;vol+=(cs[k].volume||0);}return vol>0?net/vol*100:null;};
    const redStreakAt=(t:number):number=>{let s=0;for(let k=t;k>t-5;k--){const c=concByDate.get(cs[k].date);if(c!=null&&c>0)s++;else break;}return s;};

    for(let t=6;t+1+FWD<cs.length;t++){
      if(!concByDate.has(cs[t].date))continue;
      const cT=conc5(t), cY=conc5(t-1);
      if(cT==null||cY==null)continue;
      const dip5=(cs[t].close/cs[t-5].close-1)*100;
      const entry=cs[t+1].open; if(!(entry>0))continue;
      const exitI=Math.min(t+1+FWD,cs.length-1);
      const ret=(cs[exitI].close/entry-1)*100;
      if(Math.abs(ret)>50)continue;
      const e=twIdx(cs[t+1].date),x=twIdx(cs[exitI].date);
      const mkt=(e>=0&&x>=0&&twii[e].close>0)?(twii[x].close/twii[e].close-1)*100:0;
      rows.push({conc:cT,zfPP:cT-cY,redStreak:redStreakAt(t),dip5,ret,excess:ret-mkt});
      if(cs[t].date<minD)minD=cs[t].date; if(cs[t].date>maxD)maxD=cs[t].date;
    }
  }

  console.log('================================================');
  console.log(`徐黎芳「真正方法」回測 — 主力券商分點集中度`);
  console.log(`股票 ${stocks} 檔  期間 ${minD}~${maxD}  全體 ${rows.length.toLocaleString()} 筆`);
  console.log('================================================');
  stat('全體基準', rows);
  console.log('\n【招牌版：下跌 + 主力逆勢買】');
  const dip=rows.filter(o=>o.dip5<-3);
  stat('跌>3% (基準)', dip);
  stat('跌 + 集中度 top25%', topFrac(dip, o=>o.conc, 0.25));
  stat('跌 + 集中度 top10%', topFrac(dip, o=>o.conc, 0.10));
  console.log('\n【增幅排行版（她畫面那張，不要求跌）】');
  stat('增幅 top10%', topFrac(rows, o=>o.zfPP, 0.10));
  stat('增幅 top5%', topFrac(rows, o=>o.zfPP, 0.05));
  console.log('\n【完整配方逐步疊（招牌版基礎）】');
  let s=dip;                                    stat('跌>3%', s);
  s=topFrac(s, o=>o.conc, 0.5).filter(o=>o.conc>0); stat('+ 集中度為正且偏高', s);
  s=s.filter(o=>o.zfPP>0);                      stat('+ 增幅>0(在增加)', s);
  s=s.filter(o=>o.redStreak>=3);                stat('+ 連續紅≥3天', s);
  console.log('\n判讀：主力分點版若超額明顯>0、贏大盤>55%，就是法人代理測不到、正版才有的 edge。');
}
main().catch(e=>{console.error(e);process.exit(1);});
