'use client';

import { useEffect, useRef } from 'react';
import { useWatchlistStore } from '@/store/watchlistStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useBacktestStore } from '@/store/backtestStore';
import { useScannerStore } from '@/store/scannerStore';
import { usePortfolioStore, hydrateHoldingsFromServer } from '@/store/portfolioStore';
import { usePortfolioProfileStore } from '@/store/portfolioProfileStore';
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
  // 2026-05-29：持倉改 server 唯一真相 — 啟動時從 server 持倉檔（台股+陸股）灌入 store
  // 2026-06-04：多人 profile — 先載入 profile 清單，再灌入「目前 profile」的持倉
  useEffect(() => {
    void usePortfolioProfileStore.getState().refreshProfiles();
    void hydrateHoldingsFromServer();
  }, []);

  // 切換持倉檔案（profile）→ 清空目前持倉 + 重新從該 profile hydrate
  // 首次 render 由上面那個 effect 處理，這裡只在「之後的切換」觸發
  const activeProfileId = usePortfolioProfileStore(s => s.activeProfileId);
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return; }
    usePortfolioStore.setState({ holdings: [] });
    void hydrateHoldingsFromServer();
  }, [activeProfileId]);

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
