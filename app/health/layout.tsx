import type { Metadata } from 'next';

export const metadata: Metadata = { title: '系統狀態' };

export default function HealthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
