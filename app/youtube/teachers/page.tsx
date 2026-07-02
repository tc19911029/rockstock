'use client';

/**
 * /youtube/teachers — 老師推薦績效排行榜（獨立頁，比照 /backtest/leaderboard 先例）
 *
 * 誰講的準：YouTube 節目每筆股票提及 → 隔日開盤進場 → D+1/5/20/60 前瞻報酬
 * → 按老師/節目聚合勝率、平均報酬、超額（vs 大盤）、賺賠比。
 */

import { PageShell, PageHeader } from '@/components/shared';
import { TeacherLeaderboard } from '@/components/youtube/TeacherLeaderboard';

export default function YoutubeTeachersPage() {
  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="🎓 老師推薦績效排行榜"
          subtitle="每筆推薦 → 隔日開盤進場 → D+1/5/20/60 報酬；點老師列展開逐筆事件"
          backButton
        />
      }
    >
      <TeacherLeaderboard />
    </PageShell>
  );
}
