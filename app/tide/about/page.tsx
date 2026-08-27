import type { Metadata } from 'next';
import { TideInfoShell } from '../_components/TideInfoShell';
import styles from '../_components/info.module.css';

export const metadata: Metadata = { title: '關於本站｜潮汐 Pro 獨立重建版' };

export default function AboutPage() {
  return <TideInfoShell title="關於本站" description="把分散的台股法人公開資料整理成容易閱讀的板塊與個股資金視圖。">
    <h2>我們做什麼</h2><p>這個介面讀取專案內已整理的法人與股價資料，提供板塊泡泡圖、籌碼排行榜、個股法人分項、資金軌跡回放、提醒與雷達。目標是幫助使用者快速理解公開資料，不是提供明牌。</p>
    <div className={styles.featureGrid}><article><h3>每天盤後整理</h3><p>資料完成後顯示日期與法人資金方向，避免把舊資料誤認成今日。</p></article><article><h3>板塊優先</h3><p>先看錢進到哪個產業，再打開成分股確認主要貢獻來源。</p></article><article><h3>只陳述籌碼事實</h3><p>排行、徽章與力道都是統計描述，不代表未來一定上漲或下跌。</p></article></div>
    <h2>資料從哪裡來</h2><p>主要資料源為臺灣證券交易所與證券櫃檯買賣中心公開資訊，搭配本專案既有的歷史 K 線快取。官方資料可能延遲、修正或缺漏，重大決策應回到官方原始公告核對。</p>
    <h2>與 Tide 原站的關係</h2><div className={styles.notice}><p>本站是依公開可見功能重新設計與等價實作的獨立版本，沒有取得 Tide 原站程式碼、會員資料、付費資料或私有演算法，也不是 Tide 官方網站。</p></div>
  </TideInfoShell>;
}
