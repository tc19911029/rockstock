import { redirect } from 'next/navigation';
import { validYmd } from '@/lib/cn-media/date';

export default async function CnMediaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requestedDate = typeof params.date === 'string' ? params.date : '';
  const target = new URLSearchParams({ tab: 'youtube', ytSub: 'cn' });
  if (validYmd(requestedDate)) target.set('date', requestedDate);
  redirect(`/?${target.toString()}`);
}
