'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Users, Check, Plus, Pencil, Trash2, ChevronDown } from 'lucide-react';
import { usePortfolioProfileStore } from '@/store/portfolioProfileStore';

/**
 * 持倉「檔案」(profile) 切換器 — 在底部持倉面板與 /portfolio 完整頁共用。
 *
 * 下拉列出所有 profile（勾選目前），底下三個動作：新增 / 重新命名 / 刪除。
 * 切換 profile 後由 StoreSync 訂閱 activeProfileId → 自動清空 + 重新 hydrate 該組持倉。
 *
 * 選單用 portal 掛到 body（fixed 定位）：底部面板的可摺疊容器有 overflow-hidden，
 * 一般 absolute 會被裁切；portal 可逃出，並依按鈕在視窗上下位置決定往上 / 往下開。
 */
export function PortfolioProfileSwitcher({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const profiles = usePortfolioProfileStore(s => s.profiles);
  const activeId = usePortfolioProfileStore(s => s.activeProfileId);
  const setActive = usePortfolioProfileStore(s => s.setActiveProfile);
  const createProfile = usePortfolioProfileStore(s => s.createProfile);
  const renameProfile = usePortfolioProfileStore(s => s.renameProfile);
  const deleteProfile = usePortfolioProfileStore(s => s.deleteProfile);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0, top: 0 });

  const active = profiles.find(p => p.id === activeId) ?? profiles[0];

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const el = triggerRef.current;
    if (el && typeof window !== 'undefined') {
      const r = el.getBoundingClientRect();
      // 按鈕落在視窗下半 → 往上開（底部面板）；否則往下開（完整頁）
      const openUp = r.bottom > window.innerHeight * 0.6;
      setPos(openUp
        ? { left: r.left, bottom: window.innerHeight - r.top + 4 }
        : { left: r.left, top: r.bottom + 4 });
    }
    setOpen(true);
  };

  const onCreate = async () => {
    const name = window.prompt('新增持倉檔案名稱（例如：朋友、老王、老媽）');
    if (!name?.trim()) return;
    const id = await createProfile(name.trim());
    if (id) setActive(id);
    setOpen(false);
  };

  const onRename = async () => {
    if (!active) return;
    const name = window.prompt('重新命名持倉檔案', active.name);
    if (!name?.trim()) return;
    await renameProfile(active.id, name.trim());
    setOpen(false);
  };

  const onDelete = async () => {
    if (!active || active.id === 'me') return;
    if (!window.confirm(`刪除「${active.name}」這組持倉檔案？\n此動作會移除該檔案的所有持倉資料，無法復原。`)) return;
    await deleteProfile(active.id);
    setOpen(false);
  };

  const btnCls = size === 'sm' ? 'text-[11px] px-2 py-1 gap-1' : 'text-xs px-2.5 py-1.5 gap-1.5';

  const menu = open && typeof document !== 'undefined' ? createPortal(
    <>
      {/* click-outside backdrop */}
      <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
      <div
        className="fixed z-[61] min-w-[13rem] rounded-lg border border-border bg-card shadow-xl py-1"
        style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}
      >
        <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">持倉檔案</div>
        {profiles.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => { setActive(p.id); setOpen(false); }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-muted text-left"
          >
            <span className="w-3.5 shrink-0">
              {p.id === activeId && <Check className="w-3.5 h-3.5 text-sky-400" />}
            </span>
            <span className="flex-1 truncate">{p.name}</span>
            {p.id === 'me' && <span className="text-[9px] text-muted-foreground/60 shrink-0">預設</span>}
          </button>
        ))}

        <div className="my-1 border-t border-border" />

        <button type="button" onClick={onCreate}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-muted text-left text-sky-400">
          <Plus className="w-3.5 h-3.5 shrink-0" /> 新增持倉檔案
        </button>
        <button type="button" onClick={onRename}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-muted text-left">
          <Pencil className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">重新命名「{active?.name}」</span>
        </button>
        {active?.id !== 'me' && (
          <button type="button" onClick={onDelete}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-muted text-left text-rose-400">
            <Trash2 className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">刪除「{active?.name}」</span>
          </button>
        )}
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className={`flex items-center rounded-md bg-secondary hover:bg-muted text-foreground/90 transition-colors ${btnCls}`}
        title="切換 / 管理持倉檔案"
      >
        <Users className="w-3.5 h-3.5 text-sky-400 shrink-0" />
        <span className="font-medium truncate max-w-[7rem]">{active?.name ?? '我的'}</span>
        <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {menu}
    </>
  );
}
