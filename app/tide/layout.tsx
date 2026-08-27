import { PageShell } from '@/components/shared/PageShell';

export default function TideLayout({ children }: { children: React.ReactNode }) {
  return <PageShell>{children}</PageShell>;
}
