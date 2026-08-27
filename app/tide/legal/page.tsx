import type { Metadata } from 'next';
import { TideInfoShell } from '../_components/TideInfoShell';
import styles from '../_components/info.module.css';

export const metadata: Metadata = { title: '條款・隱私・退款｜潮汐 Pro 獨立重建版' };
export default function LegalPage() {
  return <TideInfoShell title="服務條款・隱私權・退款說明" description="本頁僅適用這個獨立重建專案，不是 Tide 原站的法律條款。">
    <nav className={styles.toc}><a href="#terms">服務條款</a><a href="#privacy">隱私權</a><a href="#refund">退款說明</a></nav>
    <section id="terms"><h2>服務條款</h2><h3>服務內容</h3><p>本站將公開市場資料整理為圖表、排行與歷史視圖。所有內容以現狀提供，可能因官方來源延遲、缺漏或修正而變動。</p><h3>投資風險</h3><div className={styles.notice}><p><strong>本站不是證券投資顧問，所有內容不構成投資分析意見、推介、要約或獲利保證。</strong>任何交易決策與結果由使用者自行承擔。</p></div><h3>合理使用</h3><p>不得利用本站從事違法活動、未授權大量擷取、冒充官方服務或散布足以誤導他人的內容。</p></section>
    <section id="privacy"><h2>隱私權說明</h2><p>登入、邀請、投票、自選、提醒與許願池在目前版本均儲存在你的瀏覽器 localStorage；本站不要求信用卡，也不會取得 Google 帳號、密碼或 Tide 原站會員資料。清除瀏覽器網站資料即可移除這些本機紀錄。</p></section>
    <section id="refund"><h2>退款說明</h2><p>此獨立重建版沒有收費與真實訂閱，因此沒有扣款、續約或退款流程。若未來另行接入真實金流，必須在付款前另行公布適用的商家資訊、價格、取消與退款條款。</p></section>
  </TideInfoShell>;
}
