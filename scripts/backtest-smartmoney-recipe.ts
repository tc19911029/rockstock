/**
 * 徐黎芳「完整配方」回測（法人代理，3.5 年）
 *   不是拆零件 — 把她影片講的條件「疊起來」測：
 *     熱門股(成交額高) + 5日集中度高 + 增幅>0(在增加) + 連續多天紅(紅成一片) + 去年沒漲多
 *   兩種框架：①增幅排行版(她畫面那張表，不要求在跌) ②招牌版(下跌+主力逆勢買)
 *   進場隔日開盤、持有5日、算贏大盤(^TWII)。逐步疊條件看樣本數與超額。
 */
import { promises as fs } from 'fs';
import path from 'path';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const FWD = 5;

interface OHLC { date: string; close: number; volume: number }
interface Obs {
  conc: number; zfPP: number; redStreak: number; past240: number; turnover: number; dip5: number;
  ret: number; excess: number;
}

function stat(label: string, rows: Obs[]) {
  if (rows.length < 3) { console.log(`  ${label.padEnd(30)} ${rows.length}筆(太少)`); return; }
  const n = rows.length;
  const avg = rows.reduce((s, r) => s + r.ret, 0) / n;
  const win = 100 * rows.filter(r => r.ret > 0).length / n;
  const exc = rows.reduce((s, r) => s + r.excess, 0) / n;
  const winM = 100 * rows.filter(r => r.excess > 0).length / n;
  console.log(`  ${label.padEnd(30)} ${String(n).padStart(5)}筆 | 報酬${avg>=0?'+':''}${avg.toFixed(2)}% | 勝${win.toFixed(0)}% | 超額${exc>=0?'+':''}${exc.toFixed(2)}% | 贏大盤${winM.toFixed(0)}%`);
}

async function main() {
  const files = (await fs.readdir(INST_DIR)).filter(f => f.endsWith('.json'));
  const twii: OHLC[] = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, '^TWII.json'), 'utf8')).candles;
  const td = twii.map(c => c.date);
  const twIdx = (d: string) => { let lo=0,hi=td.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(td[m]<=d){a=m;lo=m+1}else hi=m-1} return a; };

  // 先收集所有 obs（含當日成交額，之後算每日熱門 top）
  const raw: (Obs & { date: string })[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    if (!/^\d{4}$/.test(code)) continue;
    let inst:any, cdl:any;
    try { inst=JSON.parse(await fs.readFile(path.join(INST_DIR,f),'utf8')); cdl=JSON.parse(await fs.readFile(path.join(CANDLE_DIR,`${code}.TW.json`),'utf8')); } catch { continue; }
    const im=new Map<string,number>(); for(const d of (inst.data||[])) im.set(d.date,d.total??0);
    const cs:OHLC[]=(cdl.candles||[]).filter((c:OHLC)=>c.close>0);
    if(cs.length<250) continue;
    const tot=cs.map(c=>im.get(c.date)??null);

    const conc5=(t:number):number|null=>{let i=0,v=0;for(let k=t-4;k<=t;k++){if(!im.has(cs[k].date))return null;const it=im.get(cs[k].date)!;if(Math.abs(it)>(cs[k].volume||0)*1.5&&cs[k].volume>0)return null;i+=it;v+=cs[k].volume||0;}return v>0?i/v*100:null;};

    for(let t=240;t+FWD<cs.length;t++){
      if(!im.has(cs[t].date))continue;
      const cT=conc5(t), cY=conc5(t-1);
      if(cT==null||cY==null)continue;
      // 連續多天紅 = 近5日法人淨買為正的天數
      let red=0; for(let k=t;k>t-5;k--){ if((tot[k]??-1)>0)red++; else break; }
      const past240=(cs[t].close/cs[t-240].close-1)*100;
      const turnover=cs[t].close*(cs[t].volume||0);
      const dip5=(cs[t].close/cs[t-5].close-1)*100;
      const entry=cs[t+1]?.close; // 用收盤近似(隔日開盤另算)
      const exitI=Math.min(t+FWD,cs.length-1);
      const ret=(cs[exitI].close/cs[t].close-1)*100;
      if(Math.abs(ret)>50)continue;
      const e=twIdx(cs[t].date), x=twIdx(cs[exitI].date);
      const mkt=(e>=0&&x>=0&&twii[e].close>0)?(twii[x].close/twii[e].close-1)*100:0;
      raw.push({date:cs[t].date,conc:cT,zfPP:cT-cY,redStreak:red,past240,turnover,dip5,ret,excess:ret-mkt});
    }
  }

  // 每日熱門：當日成交額 rank top 200 標記
  const byDate=new Map<string,(Obs&{date:string})[]>();
  for(const o of raw){ (byDate.get(o.date)||byDate.set(o.date,[]).get(o.date)!).push(o); }
  const hot=new Set<Obs&{date:string}>();
  for(const arr of byDate.values()){ arr.sort((a,b)=>b.turnover-a.turnover); for(const o of arr.slice(0,200))hot.add(o); }

  const minD=raw.reduce((m,o)=>o.date<m?o.date:m,'9999'), maxD=raw.reduce((m,o)=>o.date>m?o.date:m,'0');
  console.log('================================================');
  console.log('徐黎芳「完整配方」回測（法人代理）');
  console.log(`期間 ${minD}~${maxD}  全體 ${raw.length.toLocaleString()} 筆  進場持有${FWD}日`);
  console.log('================================================');
  stat('全體基準', raw);
  console.log('\n【框架①：增幅排行版（不要求在跌，照她畫面那張表）逐步疊】');
  let s = raw.filter(o=>hot.has(o));                         stat('熱門股(成交額top200)', s);
  s = s.filter(o=>o.conc>5);                                 stat('+ 集中度>5%', s);
  s = s.filter(o=>o.zfPP>0);                                 stat('+ 增幅>0(在增加)', s);
  s = s.filter(o=>o.redStreak>=3);                           stat('+ 連續紅≥3天(紅成一片)', s);
  s = s.filter(o=>o.past240<50);                             stat('+ 去年漲<50%(補漲空間)', s);
  console.log('\n【框架②：招牌版（下跌+主力逆勢買）逐步疊】');
  let d = raw.filter(o=>hot.has(o) && o.dip5<-3);            stat('熱門 + 近5日跌>3%', d);
  d = d.filter(o=>o.conc>8);                                 stat('+ 集中度>8%', d);
  d = d.filter(o=>o.zfPP>0);                                 stat('+ 增幅>0', d);
  d = d.filter(o=>o.redStreak>=3);                           stat('+ 連續紅≥3天', d);
  d = d.filter(o=>o.past240<50);                             stat('+ 去年漲<50%', d);
  console.log('\n判讀：每疊一條看「樣本數」會不會掉太快(<30=不可信)、超額有沒有真的轉正且贏大盤>55%。');
}
main().catch(e=>{console.error(e);process.exit(1);});
