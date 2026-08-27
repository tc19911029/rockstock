import type { Metadata } from 'next';
import Link from 'next/link';
import { TideInfoShell } from '../_components/TideInfoShell';
import styles from '../_components/info.module.css';

export const metadata: Metadata = { title: '方案與定價｜潮汐 Pro 獨立重建版' };

const proFeatures = [
  '免費版全部功能', '完整籌碼排行', '外資投信同買／同賣榜', '外資連買／連賣榜',
  '法人分項：當日、近 5 日與 20 日', '法人 20 日均價與走勢均價線', '外資連續買賣天數',
  '法人力道標', '個股歷史回看', '具名籌碼異動', '不限檔籌碼監控', '多條件籌碼雷達與歷史資料',
];
const freeFeatures = ['三大法人資金泡泡圖', '板塊籌碼排行榜', '板塊與個股資金軌跡回放', '每日盤面重點', '自選股與多空投票', '全站無廣告'];

export default function PricingPage() {
  return (
    <TideInfoShell title="方案與定價" description="Tide 只做一件事：盤後告訴你，法人的錢往哪裡去了。不做 K 線、不做財報、不做盤中報價——那些別的地方都有。免費開始，需要更深入的分析再升級 Pro。">
      <p><Link href="/tide/about">關於 Tide：誰做的、資料哪來、板塊怎麼分 →</Link></p>
      <h2>方案比較</h2>
      <section className={styles.subscribeCard}><span className={styles.badge}>★ Tide Pro</span><h2>訂閱 Tide Pro</h2><p>年繳平均每月約 NT$166、一天約 NT$5.5</p><div className={styles.subscribeActions}><Link href="/tide?buy=annual">年繳 NT$1,990</Link><Link href="/tide?buy=monthly">月繳 NT$199／月</Link></div><small className={styles.subscribeNote}>年繳可用信用卡或 ATM 轉帳・月繳為每月自動扣款；本機重建版不會送出真實付款</small></section>
      <section className={styles.cards}>
        <article className={styles.planCard} data-featured="true"><span className={styles.badge}>PRO</span><h2>訂閱</h2><div className={styles.price}><b>NT$1,990</b><span>／年</span></div><p>同一批公開資料，多看到「誰在買、買了幾天、成本在哪」。本機版已完整啟用。</p><ul>{proFeatures.map((feature) => <li key={feature}>{feature}</li>)}</ul><Link className={styles.cta} href="/tide">立即使用 Pro 全功能</Link></article>
        <article className={styles.planCard}><span className={styles.badge}>FREE</span><h2>免費版</h2><div className={styles.price}><b>NT$0</b><span>永久免費</span></div><p>保留閱讀法人資金流向所需的基礎功能。</p><ul>{freeFeatures.map((feature) => <li key={feature}>{feature}</li>)}</ul><Link className={styles.cta} href="/tide">回到儀表板</Link></article>
      </section>
      <div className={styles.notice}><p><strong>付款說明：</strong>此為獨立重建版，不使用 Tide 原站帳號、NewebPay 或任何真實訂閱；介面中的登入、邀請與會員狀態均為本機示範。</p></div>
      <h2>Pro 深度包含什麼</h2>
      <div className={styles.featureGrid}><article><h3>看誰在買</h3><p>外資、投信、自營商分項，並提供同買、同賣與土洋對作辨識。</p></article><article><h3>看買了多久</h3><p>外資連續買賣天數、近 5／20 日合計與歷史日期切換。</p></article><article><h3>看力道與成本</h3><p>以近 20 日常態衡量力道倍數，搭配法人加權均價線。</p></article></div>
    </TideInfoShell>
  );
}
