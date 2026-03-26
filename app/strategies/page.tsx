'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSettingsStore } from '@/store/settingsStore';
import {
  BUILT_IN_STRATEGIES,
  StrategyConfig,
  StrategyConditionToggles,
  StrategyThresholds,
} from '@/lib/strategy/StrategyConfig';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONDITION_LABELS: Record<keyof StrategyConditionToggles, string> = {
  trend:     '趨勢條件',
  position:  '位置條件（不在末升段）',
  kbar:      'K棒條件（長紅突破前高）',
  ma:        '均線條件（多頭排列）',
  volume:    '量能條件（量增）',
  indicator: '指標條件（MACD/KD）',
};

const THRESHOLD_LABELS: Record<keyof StrategyThresholds, string> = {
  maShortPeriod:     '短期均線週期',
  maMidPeriod:       '中期均線週期',
  maLongPeriod:      '長期均線週期',
  kbarMinBodyPct:    'K棒實體最小比例',
  upperShadowMax:    '上影線最大比例',
  volumeRatioMin:    '量比門檻',
  kdMaxEntry:        'KD 進場上限',
  deviationMax:      'MA20 乖離上限',
  minScore:          '最低進場分數',
  marketTrendFilter: '大盤趨勢過濾',
  bullMinScore:      '多頭最低分數',
  sidewaysMinScore:  '盤整最低分數',
  bearMinScore:      '空頭最低分數',
};

function formatThresholdValue(key: keyof StrategyThresholds, value: number | boolean): string {
  if (typeof value === 'boolean') return value ? '啟用' : '停用';
  const pctKeys: Array<keyof StrategyThresholds> = [
    'kbarMinBodyPct', 'upperShadowMax', 'deviationMax',
  ];
  if (pctKeys.includes(key)) return `${(value * 100).toFixed(0)}%`;
  if (key === 'volumeRatioMin') return `${value}x`;
  return String(value);
}

// ── Strategy Card ─────────────────────────────────────────────────────────────

interface StrategyCardProps {
  strategy: StrategyConfig;
  isActive: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onActivate: () => void;
  onDelete?: () => void;
}

function StrategyCard({ strategy, isActive, isSelected, onSelect, onActivate, onDelete }: StrategyCardProps) {
  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer rounded-xl border p-4 transition-all ${
        isSelected
          ? 'border-blue-500 bg-blue-900/20'
          : isActive
          ? 'border-violet-500 bg-violet-900/10'
          : 'border-slate-700 bg-slate-800/50 hover:border-slate-500'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-white">{strategy.name}</span>
            {isActive && (
              <span className="text-xs px-1.5 py-0.5 bg-violet-600 rounded text-white">使用中</span>
            )}
            {strategy.isBuiltIn && (
              <span className="text-xs px-1.5 py-0.5 bg-slate-600 rounded text-slate-300">內建</span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">{strategy.description}</p>
          <div className="flex gap-3 mt-2 text-xs text-slate-500">
            <span>v{strategy.version}</span>
            <span>作者：{strategy.author}</span>
          </div>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <button
            onClick={e => { e.stopPropagation(); onActivate(); }}
            disabled={isActive}
            className={`text-xs px-3 py-1 rounded font-medium transition ${
              isActive
                ? 'bg-violet-800 text-violet-400 cursor-default'
                : 'bg-violet-600 hover:bg-violet-500 text-white'
            }`}
          >
            {isActive ? '已啟用' : '啟用'}
          </button>
          {!strategy.isBuiltIn && onDelete && (
            <button
              onClick={e => { e.stopPropagation(); onDelete(); }}
              className="text-xs px-3 py-1 rounded bg-red-800/60 hover:bg-red-700 text-red-300 transition"
            >
              刪除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Strategy Detail Panel ─────────────────────────────────────────────────────

function StrategyDetail({ strategy }: { strategy: StrategyConfig }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-white mb-3">條件開關</h3>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(strategy.conditions) as Array<keyof StrategyConditionToggles>).map(key => (
            <div key={key} className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${strategy.conditions[key] ? 'bg-green-400' : 'bg-slate-600'}`} />
              <span className="text-xs text-slate-300">{CONDITION_LABELS[key]}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-white mb-3">閾值參數</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
          {(Object.keys(strategy.thresholds) as Array<keyof StrategyThresholds>).map(key => (
            <div key={key} className="flex justify-between items-center text-xs">
              <span className="text-slate-400">{THRESHOLD_LABELS[key]}</span>
              <span className="text-white font-mono ml-2">
                {formatThresholdValue(key, strategy.thresholds[key] as number | boolean)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Add Custom Strategy Form ──────────────────────────────────────────────────

function AddStrategyForm({ onAdd, onCancel }: { onAdd: (s: StrategyConfig) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [minScore, setMinScore] = useState(4);
  const [kdMaxEntry, setKdMaxEntry] = useState(88);
  const [volumeRatioMin, setVolumeRatioMin] = useState(1.5);
  const [upperShadowMax, setUpperShadowMax] = useState(0.20);
  const [deviationMax, setDeviationMax] = useState(0.20);

  function handleSubmit() {
    if (!name.trim()) return;
    const id = `custom-${Date.now()}`;
    const config: StrategyConfig = {
      id,
      name: name.trim(),
      description: description.trim(),
      version: '1.0.0',
      author: '使用者自訂',
      createdAt: new Date().toISOString(),
      isBuiltIn: false,
      conditions: {
        trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true,
      },
      thresholds: {
        maShortPeriod: 5,
        maMidPeriod: 10,
        maLongPeriod: 20,
        kbarMinBodyPct: 0.02,
        upperShadowMax,
        volumeRatioMin,
        kdMaxEntry,
        deviationMax,
        minScore,
        marketTrendFilter: true,
        bullMinScore: minScore,
        sidewaysMinScore: Math.min(minScore + 1, 6),
        bearMinScore: 6,
      },
    };
    onAdd(config);
  }

  return (
    <div className="rounded-xl border border-blue-600/50 bg-blue-900/10 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-white">新增自訂策略</h3>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="text-xs text-slate-400 mb-1 block">策略名稱</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="例：我的策略 v1"
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-slate-400 mb-1 block">說明</label>
          <input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="策略說明..."
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">最低進場分數（1–6）</label>
          <input
            type="number" min={1} max={6} value={minScore}
            onChange={e => setMinScore(Number(e.target.value))}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">KD 進場上限</label>
          <input
            type="number" min={50} max={100} value={kdMaxEntry}
            onChange={e => setKdMaxEntry(Number(e.target.value))}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">量比門檻</label>
          <input
            type="number" min={1} max={5} step={0.1} value={volumeRatioMin}
            onChange={e => setVolumeRatioMin(Number(e.target.value))}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">上影線最大比例（0–1）</label>
          <input
            type="number" min={0} max={1} step={0.01} value={upperShadowMax}
            onChange={e => setUpperShadowMax(Number(e.target.value))}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">MA20 乖離上限（0–1）</label>
          <input
            type="number" min={0} max={1} step={0.01} value={deviationMax}
            onChange={e => setDeviationMax(Number(e.target.value))}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={!name.trim()}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm rounded font-medium transition"
        >
          新增策略
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded transition"
        >
          取消
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function StrategiesPage() {
  const {
    activeStrategyId,
    customStrategies,
    setActiveStrategy,
    addCustomStrategy,
    deleteCustomStrategy,
  } = useSettingsStore();

  const allStrategies = [...BUILT_IN_STRATEGIES, ...customStrategies];
  const [selectedId, setSelectedId] = useState<string>(activeStrategyId);
  const [showAddForm, setShowAddForm] = useState(false);

  const selectedStrategy = allStrategies.find(s => s.id === selectedId) ?? allStrategies[0];

  function handleAdd(s: StrategyConfig) {
    addCustomStrategy(s);
    setSelectedId(s.id);
    setShowAddForm(false);
  }

  return (
    <div className="min-h-screen bg-[#0b1120] text-white">
      {/* Header */}
      <header className="border-b border-slate-800 px-4 py-3 flex items-center gap-3">
        <Link href="/" className="text-sm text-slate-400 hover:text-white transition">
          ← 主頁
        </Link>
        <span className="text-slate-700">|</span>
        <h1 className="text-sm font-semibold text-white">策略管理</h1>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* Strategy Cards Grid */}
        <div>
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">策略列表</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {allStrategies.map(s => (
              <StrategyCard
                key={s.id}
                strategy={s}
                isActive={s.id === activeStrategyId}
                isSelected={s.id === selectedId}
                onSelect={() => setSelectedId(s.id)}
                onActivate={() => setActiveStrategy(s.id)}
                onDelete={!s.isBuiltIn ? () => deleteCustomStrategy(s.id) : undefined}
              />
            ))}

            {/* Add custom strategy button */}
            {!showAddForm && (
              <button
                onClick={() => setShowAddForm(true)}
                className="rounded-xl border border-dashed border-slate-600 bg-transparent hover:border-slate-400 hover:bg-slate-800/30 p-4 text-slate-500 hover:text-slate-300 transition text-sm font-medium flex items-center justify-center gap-2"
              >
                <span className="text-lg leading-none">+</span>
                新增自訂策略
              </button>
            )}
          </div>
        </div>

        {/* Add Form */}
        {showAddForm && (
          <AddStrategyForm
            onAdd={handleAdd}
            onCancel={() => setShowAddForm(false)}
          />
        )}

        {/* Strategy Detail */}
        {selectedStrategy && (
          <div>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
              策略詳情：{selectedStrategy.name}
            </h2>
            <StrategyDetail strategy={selectedStrategy} />
          </div>
        )}

        {/* Strategy Comparison Table */}
        <div>
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
            策略參數比較
          </h2>
          <div className="overflow-x-auto rounded-xl border border-slate-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-800/60">
                  <th className="text-left px-4 py-2.5 text-slate-400 font-medium whitespace-nowrap">參數</th>
                  {allStrategies.map(s => (
                    <th key={s.id} className="text-center px-4 py-2.5 font-medium whitespace-nowrap">
                      <span className={s.id === activeStrategyId ? 'text-violet-400' : 'text-slate-300'}>
                        {s.name}
                      </span>
                      {s.id === activeStrategyId && (
                        <span className="ml-1 text-violet-500">★</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(Object.keys(allStrategies[0].thresholds) as Array<keyof StrategyThresholds>).map((key, i) => (
                  <tr key={key} className={`border-b border-slate-800 ${i % 2 === 0 ? '' : 'bg-slate-800/20'}`}>
                    <td className="px-4 py-2 text-slate-400">{THRESHOLD_LABELS[key]}</td>
                    {allStrategies.map(s => (
                      <td key={s.id} className="px-4 py-2 text-center font-mono text-slate-200">
                        {formatThresholdValue(key, s.thresholds[key] as number | boolean)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
