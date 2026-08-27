import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import styles from './info.module.css';

export function TideInfoShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href="/tide"><ArrowLeft size={15} /> 回 Tide 台股資金潮汐</Link>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      <div className={styles.content}>{children}</div>
      <footer className={styles.footer}>
        <p>本服務彙整證交所與櫃買中心公開資料，非投資顧問，不提供投資建議。</p>
        <p>獨立重建介面，非 tide-tw.app 官方網站或關係服務。</p>
      </footer>
    </main>
  );
}
