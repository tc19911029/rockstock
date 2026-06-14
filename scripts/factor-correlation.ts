/**
 * 因子 vs 股價漲幅 相關性表（3.5 年法人資料）
 *   問題：我們量的哪些東西，真的跟「之後漲幅」正相關？
 *   每個因子算 Pearson r（+1正相關 / 0無關 / -1反相關）對「之後5日漲幅」
 *   並拆「在跌時」看 — 因為策略 edge 在「跌+集中度」的交互作用
 */
import { promises as fs } from 'fs';
import path from 'path';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const FWD = 5;

interface OHLC { date: string; close: number; volume: number }
interface Obs {
  conc: number; inst5: number; streak: number; zfPP: number; dip5: number; fwd: number;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 3) return NaN;
  let sx=0,sy=0,sxx=0,syy=0,sxy=0;
  for (let i=0;i<n;i++){sx+=xs[i];sy+=ys[i];sxx+=xs[i]*xs[i];syy+=ys[i]*ys[i];sxy+=xs[i]*ys[i];}
  const cov=sxy-sx*sy/n, vx=sxx-sx*sx/n, vy=syy-sy*sy/n;
  return (vx<=0||vy<=0)?NaN:cov/Math.sqrt(vx*vy);
}

function streakOf(arr: number[], end: number): number { let s=0; for(let i=end;i>=0;i--){if(arr[i]>0)s++;else break;} return s; }

function report(label: string, rows: Obs[], key: (o: Obs) => number) {
  const xs = rows.map(key), ys = rows.map(o => o.fwd);
  const r = pearson(xs, ys);
  console.log(`  ${label.padEnd(26)} r = ${r>=0?'+':''}${r.toFixed(3)}`);
}

async function main() {
  const files = (await fs.readdir(INST_DIR)).filter(f => f.endsWith('.json'));
  const rows: Obs[] = [];
  let minD='9999', maxD='0';

  for (const f of files) {
    const code = f.replace('.json','');
    if (!/^\d{4}$/.test(code)) continue;
    let inst:any, cdl:any;
    try { inst=JSON.parse(await fs.readFile(path.join(INST_DIR,f),'utf8')); cdl=JSON.parse(await fs.readFile(path.join(CANDLE_DIR,`${code}.TW.json`),'utf8')); } catch { continue; }
    const im=new Map<string,number>(); for(const d of (inst.data||[])) im.set(d.date,d.total??0);
    const cs:OHLC[]=(cdl.candles||[]).filter((c:OHLC)=>c.close>0);
    if(cs.length<30) continue;
    const totArr=cs.map(c=>im.get(c.date)??-1);

    const conc5=(t:number):number|null=>{let i=0,v=0;for(let k=t-4;k<=t;k++){if(!im.has(cs[k].date))return null;const it=im.get(cs[k].date)!;if(Math.abs(it)>(cs[k].volume||0)*1.5&&cs[k].volume>0)return null;i+=it;v+=cs[k].volume||0;}return v>0?i/v*100:null;};

    for(let t=6;t+FWD<cs.length;t++){
      if(!im.has(cs[t].date))continue;
      const cT=conc5(t), cY=conc5(t-1);
      if(cT==null||cY==null)continue;
      let inst5=0; for(let k=t-4;k<=t;k++)inst5+=im.get(cs[k].date)!;
      const dip5=(cs[t].close/cs[t-5].close-1)*100;
      const fwd=(cs[t+FWD].close/cs[t].close-1)*100;
      if(Math.abs(dip5)>40||Math.abs(fwd)>40)continue;
      rows.push({conc:cT,inst5,streak:streakOf(totArr,t),zfPP:cT-cY,dip5,fwd});
      if(cs[t].date<minD)minD=cs[t].date; if(cs[t].date>maxD)maxD=cs[t].date;
    }
  }

  console.log('================================================');
  console.log('因子 vs 之後5日漲幅 — Pearson 相關 (+1正/-0無/-1反)');
  console.log(`期間 ${minD}~${maxD}  全體 ${rows.length.toLocaleString()} 筆`);
  console.log('================================================');
  console.log('【全體】');
  report('法人5日集中度%', rows, o=>o.conc);
  report('法人5日淨買超(張)', rows, o=>o.inst5);
  report('法人連買天數', rows, o=>o.streak);
  report('集中度增幅(pp)', rows, o=>o.zfPP);
  report('近5日漲跌%(跌=負)', rows, o=>o.dip5);
  console.log('\n【只看「在跌」的(近5日跌>3%)】 — 策略 edge 所在');
  const dip=rows.filter(o=>o.dip5<-3);
  console.log(`  (子樣本 ${dip.length.toLocaleString()} 筆)`);
  report('法人5日集中度%', dip, o=>o.conc);
  report('法人5日淨買超(張)', dip, o=>o.inst5);
  report('集中度增幅(pp)', dip, o=>o.zfPP);
  console.log('\n判讀：r 絕對值 >0.05 才算有點關係；接近 0 = 沒關係。');
  console.log('預期：單因子都接近0(沒用)，但「在跌」子樣本裡集中度會轉正(這就是策略的料)。');
}
main().catch(e=>{console.error(e);process.exit(1);});
