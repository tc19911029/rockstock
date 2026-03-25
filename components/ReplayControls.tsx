'use client';

import { useEffect, useRef } from 'react';
import { useReplayStore } from '@/store/replayStore';

const SPEED_OPTIONS = [
  { label: '慢', ms: 1500 },
  { label: '1×', ms: 800  },
  { label: '快', ms: 350  },
  { label: '極速', ms: 100 },
];

const INTERVAL_LABEL: Record<string, string> = {
  '1d': '日', '1wk': '週', '1mo': '月',
};

export default function ReplayControls() {
  const {
    allCandles, currentIndex, isPlaying, playSpeed, currentInterval,
    nextCandle, prevCandle, startPlay, stopPlay, setPlaySpeed, resetReplay, jumpToIndex,
  } = useReplayStore();

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isPlaying) {
      timerRef.current = setInterval(() => {
        const s = useReplayStore.getState();
        if (s.currentIndex >= s.allCandles.length - 1) {
          s.stopPlay();
        } else {
          s.nextCandle();
        }
      }, playSpeed);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isPlaying, playSpeed]);

  const total   = allCandles.length;
  const pos     = currentIndex + 1;
  const pct     = total > 0 ? (pos / total) * 100 : 0;
  const remaining = total - pos;

  const current = allCandles[currentIndex];
  const kLabel  = INTERVAL_LABEL[currentInterval] ?? '日';

  return (
    <div className="bg-slate-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">走圖控制</h2>
        <span className="text-xs text-slate-400 font-mono">
          {kLabel}K · 第 {pos}/{total} 根
        </span>
      </div>

      {/* Current candle info */}
      {current && (
        <div className="grid grid-cols-5 gap-1 text-xs font-mono bg-slate-900 rounded p-2">
          <div className="text-slate-500 col-span-5 mb-0.5">{current.date}</div>
          <div><span className="text-slate-500">開</span> <span className="text-white">{current.open}</span></div>
          <div><span className="text-slate-500">高</span> <span className="text-green-400">{current.high}</span></div>
          <div><span className="text-slate-500">低</span> <span className="text-red-400">{current.low}</span></div>
          <div><span className="text-slate-500">收</span> <span className={current.close >= current.open ? 'text-green-400' : 'text-red-400'}>{current.close}</span></div>
          <div><span className="text-slate-500">量</span> <span className="text-slate-300">{(current.volume / 1000).toFixed(0)}K</span></div>
        </div>
      )}

      {/* Timeline scrubber */}
      <div className="space-y-1">
        <input
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          value={currentIndex}
          onChange={e => jumpToIndex(Number(e.target.value))}
          className="w-full accent-blue-500 cursor-pointer h-1.5"
        />
        <div className="flex justify-between text-xs text-slate-500">
          <span>{allCandles[0]?.date ?? ''}</span>
          <span className="text-slate-400">
            {remaining > 0 ? `還剩 ${remaining} 根未看` : '已到最新'}
          </span>
          <span>{allCandles[total - 1]?.date ?? ''}</span>
        </div>
      </div>

      {/* Control buttons */}
      <div className="flex gap-1.5">
        <button
          onClick={prevCandle}
          disabled={currentIndex <= 0 || isPlaying}
          className="flex-1 py-2 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-30 text-sm transition"
          title="上一根K線"
        >
          ◀
        </button>

        {isPlaying ? (
          <button
            onClick={stopPlay}
            className="flex-[2] py-2 rounded bg-amber-600 hover:bg-amber-500 text-sm font-bold transition"
          >
            ⏸ 暫停
          </button>
        ) : (
          <button
            onClick={startPlay}
            disabled={currentIndex >= total - 1}
            className="flex-[2] py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-sm font-bold transition"
          >
            ▶ 自動播放
          </button>
        )}

        <button
          onClick={nextCandle}
          disabled={currentIndex >= total - 1 || isPlaying}
          className="flex-1 py-2 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-30 text-sm transition"
          title="下一根K線"
        >
          ▶
        </button>
      </div>

      {/* Speed */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-slate-500 w-10 shrink-0">速度</span>
        {SPEED_OPTIONS.map(opt => (
          <button
            key={opt.ms}
            onClick={() => setPlaySpeed(opt.ms)}
            className={`flex-1 py-1 rounded text-xs transition ${
              playSpeed === opt.ms
                ? 'bg-blue-600 text-white'
                : 'bg-slate-700 hover:bg-slate-600 text-slate-400'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Reset */}
      <button
        onClick={resetReplay}
        className="w-full py-1.5 rounded bg-slate-700 hover:bg-red-900/60 text-slate-400 hover:text-red-300 text-xs transition"
      >
        ↺ 重置走圖（保留帳戶資料請自行記錄）
      </button>
    </div>
  );
}
