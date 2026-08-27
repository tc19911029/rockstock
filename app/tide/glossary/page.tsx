import type { Metadata } from 'next';
import { TideInfoShell } from '../_components/TideInfoShell';
import styles from '../_components/info.module.css';

export const metadata: Metadata = { title: '名詞小百科｜潮汐 Pro 獨立重建版' };
const terms = [
  ['三大法人', '外資、投信與自營商三類機構投資人的統稱。'],
  ['買賣超', '買進張數減去賣出張數；正數是買超，負數是賣超。'],
  ['漲潮／輪動／觀望／退潮', '依資金方向與速度交叉分成四種狀態，用來描述資金正在加速流入、放緩、回補或流出。'],
  ['法人分項', '把三大法人合計拆成外資、投信、自營商，避免合計數字掩蓋彼此相反的方向。'],
  ['土洋同買／同賣', '外資與投信同一天方向一致；只描述籌碼事實，不等於買賣訊號。'],
  ['土洋對作', '外資與投信同一天方向相反，表示不同類型法人對該股看法或策略不同。'],
  ['外資停留', '從指定日期往回計算，外資連續買超或賣超的交易日數。'],
  ['力道標', '今日法人買賣超絕對值相對近 20 日平均絕對值的倍數；越高代表今日偏離常態越大。'],
  ['法人 20 日均價', '以近 20 日法人買超張數作權重估算的價格帶，僅為統計近似值。'],
  ['資金軌跡回放', '逐日切換歷史資料，觀察板塊或個股在不同資金象限之間如何移動。'],
];
export default function GlossaryPage() {
  return <TideInfoShell title="名詞小百科" description="不用背公式，用白話快速理解泡泡圖與 Pro 籌碼功能。">
    <nav className={styles.toc}>{terms.map(([term], index) => <a href={`#term-${index}`} key={term}>{term}</a>)}</nav>
    {terms.map(([term, description], index) => <article className={styles.term} id={`term-${index}`} key={term}><h3>{term}是什麼？</h3><p>{description}</p></article>)}
  </TideInfoShell>;
}
