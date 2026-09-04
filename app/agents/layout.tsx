import type { Metadata } from 'next';

export const metadata: Metadata = { title: '多代理決策' };

export default function AgentsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
