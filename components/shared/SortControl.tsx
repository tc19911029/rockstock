'use client';

/**
 * 共用排序選單（pills）— 全站一份（2026-06-15）
 *
 * 取代散在各面板各寫一遍的排序按鈕列。各面板只宣告「我要哪幾個排序選項」，
 * label / tip / 預設方向 自動從 lib/sorting/registry 取，點同個 pill 切升降序的邏輯
 * 只寫在這裡。
 *
 * 用法：
 *   const [sortId, setSortId] = useState('mkt.turnover');
 *   const [dir, setDir] = useState<SortDir>('desc');
 *   <SortControl
 *     options={['mkt.turnover', 'mkt.change', 'fwd.d5', { id: 'name', label: '名稱' }]}
 *     value={sortId} dir={dir}
 *     onChange={(id, d) => { setSortId(id); setDir(d); }}
 *   />
 *
 * 排序實際套用交給 lib/sorting/sortEngine.applySort（accessor 各面板自理）。
 */

import { sortOption, type SortDir, type SortOptionDef } from '@/lib/sorting/registry';

/** 排序選項：可傳 registry id（字串），或 inline 自訂（純資料欄如代號/名稱用） */
export type SortControlOption =
  | string
  | { id: string; label: string; tip?: string; defaultDir?: SortDir };

function resolve(opt: SortControlOption): { id: string; label: string; tip?: string; defaultDir: SortDir } {
  if (typeof opt === 'string') {
    const def: SortOptionDef = sortOption(opt);
    return { id: def.id, label: def.label, tip: def.tip, defaultDir: def.defaultDir };
  }
  return { id: opt.id, label: opt.label, tip: opt.tip, defaultDir: opt.defaultDir ?? 'desc' };
}

export interface SortControlProps {
  options: SortControlOption[];
  /** 目前選中的排序 id */
  value: string;
  /** 目前方向 */
  dir: SortDir;
  /** 點選回呼：點同個 → 切方向；點不同 → 換 id 並用該選項 defaultDir */
  onChange: (id: string, dir: SortDir) => void;
  /** 前綴小字，預設「排序」；傳 null 不顯示 */
  leading?: string | null;
  /** 尺寸：compact=text-[9px]（掃描卡片）、normal=text-xs（一般面板） */
  size?: 'compact' | 'normal';
  className?: string;
}

export function SortControl({
  options,
  value,
  dir,
  onChange,
  leading = '排序',
  size = 'compact',
  className = '',
}: SortControlProps) {
  const txt = size === 'compact' ? 'text-[9px]' : 'text-xs';
  const pad = size === 'compact' ? 'px-2 py-1 min-h-7' : 'px-3 py-1.5 min-h-9';

  const handleClick = (id: string, defaultDir: SortDir) => {
    if (value === id) onChange(id, dir === 'desc' ? 'asc' : 'desc');
    else onChange(id, defaultDir);
  };

  return (
    <div className={`flex flex-wrap gap-1 items-center ${className}`}>
      {leading != null && (
        <span className={`${txt} text-muted-foreground/70 mr-0.5`}>{leading}</span>
      )}
      {options.map((opt, i) => {
        // '|' = 分隔線：共用區 與 該頁專屬區 的視覺分界
        if (opt === '|') {
          return <span key={`div-${i}`} className="w-px self-stretch bg-border mx-0.5" aria-hidden="true" />;
        }
        const { id, label, tip, defaultDir } = resolve(opt);
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => handleClick(id, defaultDir)}
            title={tip}
            aria-pressed={active}
            aria-label={`${label}排序${active ? `，目前${dir === 'desc' ? '由高到低' : '由低到高'}，點擊切換方向` : ''}`}
            className={`${txt} ${pad} cursor-pointer rounded-full whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
              active ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground'
            }`}
          >
            {label}
            {active && <span className="ml-0.5">{dir === 'desc' ? '▼' : '▲'}</span>}
          </button>
        );
      })}
    </div>
  );
}
