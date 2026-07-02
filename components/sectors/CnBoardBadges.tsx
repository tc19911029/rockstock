'use client';

/**
 * 陸股個股板別／風險徽章（2026-06-24）— 純標示，不進選股。
 *
 * 在題材分類的陸股成分股旁標出：
 *   - ST／退市（風險警示，漲跌幅限 5%）
 *   - 創業板（30x，漲跌幅 20%）
 *   - 科創板（688/689，漲跌幅 20%）
 *
 * 板別判定 + ST 判定一律走單一事實 lib/cn-agents/cnBoard，不在 UI 自己重寫號段規則。
 */

import { classifyCnBoard, isStName } from '@/lib/cn-agents/cnBoard';

export function CnBoardBadges({ code, name }: { code: string; name?: string }) {
  const bare = (code || '').replace(/\D/g, '').padStart(6, '0');
  const board = classifyCnBoard(bare);
  const nm = name ?? '';
  const stLabel = isStName(nm) ? (nm.includes('退') && !nm.includes('ST') ? '退市' : 'ST') : null;

  const tags: Array<{ key: string; label: string; cls: string; title: string }> = [];
  if (stLabel) {
    tags.push({
      key: 'st', label: stLabel, cls: 'bg-yellow-500/15 text-yellow-500',
      title: '風險警示／退市整理（ST／*ST／退）：財務或經營異常，漲跌幅限 5%，風險高',
    });
  }
  if (board === 'ChiNext') {
    tags.push({
      key: 'chinext', label: '創業板', cls: 'bg-purple-500/15 text-purple-400',
      title: '創業板（30x）：成長型企業，漲跌幅限 20%，波動較大',
    });
  } else if (board === 'STAR') {
    tags.push({
      key: 'star', label: '科創板', cls: 'bg-cyan-500/15 text-cyan-400',
      title: '科創板（688／689）：硬科技企業，漲跌幅限 20%，波動較大',
    });
  }
  if (tags.length === 0) return null;

  return (
    <>
      {tags.map((t) => (
        <span key={t.key} title={t.title}
          className={`text-[10px] px-1 py-0.5 rounded whitespace-nowrap ${t.cls}`}>{t.label}</span>
      ))}
    </>
  );
}
