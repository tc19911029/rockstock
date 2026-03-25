import { Candle } from '@/types';

/**
 * Mock OHLCV data for a fictional stock (模擬台股日線資料)
 *
 * Data format:
 * { date, open, high, low, close, volume }
 *
 * To replace with real data:
 * 1. Fetch from your preferred API (e.g. Yahoo Finance, TWSE, Fugle)
 * 2. Transform to this same Candle format
 * 3. Pass into the app via loadCandleData()
 *
 * This mock dataset simulates a bull trend → consolidation → new bull breakout pattern,
 * which is ideal for practicing the SOP from Lin Ying's book.
 */

function generateMockData(): Candle[] {
  const data: Candle[] = [];
  let price = 45;
  let date = new Date('2023-01-03');
  const rng = (min: number, max: number) => min + Math.random() * (max - min);

  // Phase 1: 底部盤整 (40 days)
  for (let i = 0; i < 40; i++) {
    const open = price + rng(-0.5, 0.5);
    const close = price + rng(-1.5, 1.5);
    const high = Math.max(open, close) + rng(0.2, 1.2);
    const low = Math.min(open, close) - rng(0.2, 1.2);
    price = close;
    data.push({
      date: date.toISOString().split('T')[0],
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: Math.round(rng(2000, 5000)),
    });
    date.setDate(date.getDate() + 1);
    if (date.getDay() === 0) date.setDate(date.getDate() + 1); // skip Sunday
    if (date.getDay() === 6) date.setDate(date.getDate() + 2); // skip Saturday
  }

  // Phase 2: 多頭確認突破 (breakout with high volume)
  price = 47;
  for (let i = 0; i < 5; i++) {
    const open = price + rng(0, 0.5);
    const close = price + rng(1, 2.5);
    const high = Math.max(open, close) + rng(0.3, 1);
    const low = Math.min(open, close) - rng(0.1, 0.5);
    price = close;
    data.push({
      date: date.toISOString().split('T')[0],
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: Math.round(rng(8000, 18000)), // high volume breakout
    });
    date.setDate(date.getDate() + 1);
    if (date.getDay() === 0) date.setDate(date.getDate() + 1);
    if (date.getDay() === 6) date.setDate(date.getDate() + 2);
  }

  // Phase 3: 多頭趨勢上漲 (60 days)
  for (let i = 0; i < 60; i++) {
    const trend = 0.3; // daily upward drift
    const open = price + rng(-0.5, 0.8) + trend;
    const close = price + rng(-0.8, 1.5) + trend;
    const high = Math.max(open, close) + rng(0.2, 1.5);
    const low = Math.min(open, close) - rng(0.2, 1);
    price = close;
    // Occasional pullback (回檔)
    const pullback = i % 12 >= 9;
    const vol = pullback ? rng(2500, 5000) : rng(4000, 12000);
    data.push({
      date: date.toISOString().split('T')[0],
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +Math.max(low, price * 0.95).toFixed(2),
      close: +(pullback ? close - rng(1, 2) : close).toFixed(2),
      volume: Math.round(vol),
    });
    price = data[data.length - 1].close;
    date.setDate(date.getDate() + 1);
    if (date.getDay() === 0) date.setDate(date.getDate() + 1);
    if (date.getDay() === 6) date.setDate(date.getDate() + 2);
  }

  // Phase 4: 高檔盤整 + 爆量長黑 (distribution top)
  for (let i = 0; i < 15; i++) {
    const open = price + rng(-1, 1);
    const close = price + rng(-2, 1.5);
    const high = Math.max(open, close) + rng(0.5, 2);
    const low = Math.min(open, close) - rng(0.5, 2);
    price = close;
    // High volume at top
    const vol = i >= 10 ? rng(15000, 25000) : rng(5000, 10000);
    data.push({
      date: date.toISOString().split('T')[0],
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: Math.round(vol),
    });
    date.setDate(date.getDate() + 1);
    if (date.getDay() === 0) date.setDate(date.getDate() + 1);
    if (date.getDay() === 6) date.setDate(date.getDate() + 2);
  }

  // Phase 5: 空頭趨勢下跌 (50 days)
  for (let i = 0; i < 50; i++) {
    const trend = -0.4;
    const open = price + rng(-0.5, 0.3) + trend;
    const close = price + rng(-1.5, 0.5) + trend;
    const high = Math.max(open, close) + rng(0.2, 1);
    const low = Math.min(open, close) - rng(0.3, 1.5);
    price = Math.max(close, 20);
    data.push({
      date: date.toISOString().split('T')[0],
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +Math.max(low, 15).toFixed(2),
      close: +(price).toFixed(2),
      volume: Math.round(rng(3000, 9000)),
    });
    date.setDate(date.getDate() + 1);
    if (date.getDay() === 0) date.setDate(date.getDate() + 1);
    if (date.getDay() === 6) date.setDate(date.getDate() + 2);
  }

  // Phase 6: 底部打底反彈 (30 days)
  for (let i = 0; i < 30; i++) {
    const trend = 0.15;
    const open = price + rng(-0.5, 0.5) + trend;
    const close = price + rng(-1, 1.5) + trend;
    const high = Math.max(open, close) + rng(0.2, 1);
    const low = Math.min(open, close) - rng(0.1, 0.8);
    price = close;
    data.push({
      date: date.toISOString().split('T')[0],
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: Math.round(rng(3000, 8000)),
    });
    date.setDate(date.getDate() + 1);
    if (date.getDay() === 0) date.setDate(date.getDate() + 1);
    if (date.getDay() === 6) date.setDate(date.getDate() + 2);
  }

  return data;
}

// Use a fixed seed simulation so data is consistent across renders
// In production, replace with actual API call
let _cachedMockData: Candle[] | null = null;

export function loadMockData(): Candle[] {
  if (!_cachedMockData) {
    // Seed the random with a fixed sequence for reproducibility
    // (Math.random is used here for simplicity; swap to a seeded RNG for true determinism)
    _cachedMockData = generateMockData();
  }
  return _cachedMockData;
}

export const STOCK_LIST = [
  { id: 'mock-001', name: '範例股票 A (模擬多空完整走勢)', source: 'mock' },
  // Future: add real stock symbols here
  // { id: '2330', name: '台積電', source: 'api' },
];
