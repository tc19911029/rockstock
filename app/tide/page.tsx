import type { Metadata } from 'next';
import { loadTideProSnapshot } from '@/lib/tide/proData';
import { loadLatestTideMarketThemes } from '@/lib/tide/marketThemeData';
import TideDashboard from './TideDashboard';

export const metadata: Metadata = {
  title: '潮汐 Pro｜台股法人資金流向',
  description: '以泡泡圖、法人分項、連買賣與籌碼力道閱讀台股公開資料。',
};

export const dynamic = 'force-dynamic';

export default async function TidePage() {
  const [ranking, pro] = await Promise.all([
    loadLatestTideMarketThemes(),
    loadTideProSnapshot(),
  ]);

  return (
    <TideDashboard
      initialDate={ranking?.date ?? pro?.date ?? ''}
      initialThemes={ranking?.themes ?? []}
      proSnapshot={pro}
    />
  );
}
