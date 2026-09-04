import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '倉位試算',
  description: '依資金、進場價與停損價試算合適部位與單筆風險。',
};

export default function SizerLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
