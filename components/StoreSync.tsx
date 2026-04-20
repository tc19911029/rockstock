'use client';

import { useEffect } from 'react';
import { useWatchlistStore } from '@/store/watchlistStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useBacktestStore } from '@/store/backtestStore';
import { useScannerStore } from '@/store/scannerStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { useAnalysisChatStore } from '@/store/analysisChatStore';

const PERSIST_KEYS = new Set([
  'watchlist-v1',
  'settings-v4',
  'backtest-v3',
  'scanner-v4',
  'portfolio-v1',
  'analysis-chat-v1',
]);

/**
 * Listens to localStorage `storage` events and rehydrates Zustand persist
 * stores when another browser tab makes a change. Renders nothing.
 */
export default function StoreSync() {
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (!e.key || !PERSIST_KEYS.has(e.key)) return;
      switch (e.key) {
        case 'watchlist-v1':  useWatchlistStore.persist.rehydrate(); break;
        case 'settings-v4':   useSettingsStore.persist.rehydrate(); break;
        case 'backtest-v3':   useBacktestStore.persist.rehydrate(); break;
        case 'scanner-v4':    useScannerStore.persist.rehydrate(); break;
        case 'portfolio-v1':  usePortfolioStore.persist.rehydrate(); break;
        case 'analysis-chat-v1': useAnalysisChatStore.persist.rehydrate(); break;
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return null;
}
