import { ArrowLeft, Waves } from 'lucide-react';
import Link from 'next/link';
import styles from './info.module.css';

export function TideInfoShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href="/tide"><ArrowLeft size={15} /> 回潮汐儀表板</Link>
        <Link className={styles.brand} href="/tide"><span><Waves size={22} /></span><b>潮汐 Pro</b></Link>
        <h1>{title}</h1>
        <p>{description}</p>
        <nav aria-label="潮汐說明頁">
          <Link href="/tide/pricing">方案與定價</Link>
          <Link href="/tide/about">關於本站</Link>
          <Link href="/tide/glossary">名詞小百科</Link>
          <Link href="/tide/legal">條款・隱私・退款</Link>
        </nav>
      </header>
      <div className={styles.content}>{children}</div>
      <footer className={styles.footer}>
        <p>本服務彙整證交所與櫃買中心公開資料，非投資顧問，不提供投資建議。</p>
        <p>獨立重建介面，非 tide-tw.app 官方網站或關係服務。</p>
      </footer>
    </main>
  );
}
