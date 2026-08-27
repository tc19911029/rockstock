import type { Metadata } from 'next';
import { loadTideProSnapshot } from '@/lib/tide/proData';
import { loadTideMarketThemeContext } from '@/lib/tide/marketThemeData';
import TideDashboard from './TideDashboard';

export const metadata: Metadata = {
  title: '潮汐 Pro｜台股法人資金流向',
  description: '以泡泡圖、法人分項、連買賣與籌碼力道閱讀台股公開資料。',
};

export const dynamic = 'force-dynamic';

export default async function TidePage() {
  const [context, pro] = await Promise.all([
    loadTideMarketThemeContext(),
    loadTideProSnapshot(),
  ]);
  const ranking = context.latest;

  return (
    <TideDashboard
      initialDate={ranking?.date ?? pro?.date ?? ''}
      initialUniverse={ranking?.universe ?? null}
      initialThemes={ranking?.themes ?? []}
      initialHighlights={context.latestHighlights}
      priorDate={context.prior?.date ?? null}
      priorHighlights={context.priorHighlights}
      proSnapshot={pro}
    />
  );
}
