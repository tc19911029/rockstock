import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '投資組合',
  description: '集中追蹤持股、損益、風險提醒與每日操作建議。',
};

export default function PortfolioLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
