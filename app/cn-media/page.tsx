import { CnMediaDashboard } from '@/components/cn-media/CnMediaDashboard';
import { PageHeader, PageShell } from '@/components/shared';
import { validYmd } from '@/lib/cn-media/date';

function todayShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

export default async function CnMediaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requestedDate = typeof params.date === 'string' ? params.date : '';
  const initialDate = validYmd(requestedDate) ? requestedDate : todayShanghai();

  return (
    <PageShell
      headerSlot={(
        <PageHeader
          title="陸股節目雷達"
          subtitle="官方財經節目共識、A 股提及與逐字稿健康狀態"
          backButton
        />
      )}
    >
      <CnMediaDashboard initialDate={initialDate} />
    </PageShell>
  );
}
