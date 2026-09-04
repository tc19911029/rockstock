import type { Metadata } from 'next';

export const metadata: Metadata = { title: '策略回測' };

export default function BacktestLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
