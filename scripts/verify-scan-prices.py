"""
掃描結果價格驗證腳本 v2
比對掃描記錄的 price 是否等於 K 線當天的 close
覆蓋：台股/陸股 × 做多/做空 × daily/MTF × 打版(daban) × 舊格式
輸出：按日期排列 + 凍結價格偵測 + 匯總
"""

import json
import os
import glob
from collections import defaultdict

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')
CANDLE_DIR = os.path.join(DATA_DIR, 'candles')

candle_cache = {}


def load_candle_closes(market, symbol):
    key = f"{market}/{symbol}"
    if key in candle_cache:
        return candle_cache[key]
    path = os.path.join(CANDLE_DIR, market, f"{symbol}.json")
    if not os.path.exists(path):
        candle_cache[key] = None
        return None
    with open(path, 'r') as f:
        data = json.load(f)
    closes = {c['date']: c['close'] for c in data.get('candles', [])}
    candle_cache[key] = closes
    return closes


def verify_scan_file(filepath):
    with open(filepath, 'r') as f:
        data = json.load(f)

    scan_date = data.get('date', '')
    market = data.get('market', '')
    results = data.get('results', [])
    is_daban = 'daban' in os.path.basename(filepath)

    records = []
    for r in results:
        symbol = r.get('symbol', '')
        scan_price = r.get('closePrice') if is_daban else r.get('price')
        if scan_price is None:
            continue

        closes = load_candle_closes(market, symbol)
        if closes is None:
            records.append({
                'symbol': symbol, 'name': r.get('name', ''),
                'scan_price': scan_price, 'kline_close': None,
                'status': 'no_file',
            })
            continue

        actual = closes.get(scan_date)
        if actual is None:
            records.append({
                'symbol': symbol, 'name': r.get('name', ''),
                'scan_price': scan_price, 'kline_close': None,
                'status': 'no_date',
            })
            continue

        if abs(scan_price - actual) < 0.005:
            records.append({
                'symbol': symbol, 'name': r.get('name', ''),
                'scan_price': scan_price, 'kline_close': actual,
                'status': 'match',
            })
        else:
            diff = (scan_price - actual) / actual * 100
            records.append({
                'symbol': symbol, 'name': r.get('name', ''),
                'scan_price': scan_price, 'kline_close': actual,
                'diff_pct': round(diff, 2), 'status': 'mismatch',
            })

    return {'file': os.path.basename(filepath), 'date': scan_date,
            'market': market, 'records': records}


def detect_frozen_prices(all_results_by_cat):
    """偵測同一支股票在多天掃描中價格凍結不變"""
    frozen = []
    for cat, results_list in all_results_by_cat.items():
        symbol_dates = defaultdict(list)
        for res in results_list:
            for rec in res['records']:
                if rec['status'] in ('match', 'mismatch'):
                    symbol_dates[rec['symbol']].append({
                        'date': res['date'],
                        'scan_price': rec['scan_price'],
                        'kline_close': rec.get('kline_close'),
                    })
        for symbol, entries in symbol_dates.items():
            if len(entries) < 2:
                continue
            prices = [e['scan_price'] for e in entries]
            if len(set(prices)) == 1 and len(entries) >= 2:
                kline_prices = [e['kline_close'] for e in entries]
                if len(set(kline_prices)) > 1:
                    frozen.append({
                        'category': cat,
                        'symbol': symbol,
                        'frozen_price': prices[0],
                        'dates': [e['date'] for e in entries],
                        'kline_closes': kline_prices,
                    })
    return frozen


def main():
    categories = {
        'TW 舊格式':     'scan-TW-2026-*.json',
        'TW 做多 daily':  'scan-TW-long-daily-*.json',
        'TW 做多 MTF':    'scan-TW-long-mtf-*.json',
        'TW 做空 daily':  'scan-TW-short-daily-*.json',
        'TW 做空 MTF':    'scan-TW-short-mtf-*.json',
        'CN 舊格式':     'scan-CN-2026-*.json',
        'CN 做多 daily':  'scan-CN-long-daily-*.json',
        'CN 做多 MTF':    'scan-CN-long-mtf-*.json',
        'CN 做空 daily':  'scan-CN-short-daily-*.json',
        'CN 做空 MTF':    'scan-CN-short-mtf-*.json',
        'CN 打版 daban':  'daban-CN-*.json',
    }

    grand = {'total': 0, 'match': 0, 'mismatch': 0, 'no_kline': 0}
    all_mismatches = []
    all_results_by_cat = {}

    for cat_name, pattern in categories.items():
        files = sorted(glob.glob(os.path.join(DATA_DIR, pattern)))
        if not files:
            continue

        cat = {'total': 0, 'match': 0, 'mismatch': 0, 'no_kline': 0}
        cat_mismatches = []
        cat_results = []

        # 按日期排列
        date_stats = {}
        for f in files:
            res = verify_scan_file(f)
            cat_results.append(res)
            d = res['date']
            if d not in date_stats:
                date_stats[d] = {'total': 0, 'match': 0, 'mismatch': 0, 'no_kline': 0, 'mismatches': []}

            for rec in res['records']:
                cat['total'] += 1
                date_stats[d]['total'] += 1
                if rec['status'] == 'match':
                    cat['match'] += 1
                    date_stats[d]['match'] += 1
                elif rec['status'] == 'mismatch':
                    cat['mismatch'] += 1
                    date_stats[d]['mismatch'] += 1
                    entry = {**rec, 'date': d, 'category': cat_name}
                    cat_mismatches.append(entry)
                    date_stats[d]['mismatches'].append(entry)
                else:
                    cat['no_kline'] += 1
                    date_stats[d]['no_kline'] += 1

        all_results_by_cat[cat_name] = cat_results

        print(f"\n{'='*70}")
        print(f"  {cat_name}  ({len(files)} 檔)")
        print(f"  合計: {cat['total']} 支  正確: {cat['match']}  不符: {cat['mismatch']}  無K線: {cat['no_kline']}")
        pct = cat['match'] / (cat['match'] + cat['mismatch']) * 100 if (cat['match'] + cat['mismatch']) > 0 else 0
        print(f"  正確率: {pct:.1f}%")

        # 按日期顯示
        print(f"  {'─'*66}")
        print(f"  {'日期':12s} {'檢查':>5s} {'正確':>5s} {'不符':>5s} {'無K線':>5s} {'狀態'}")
        for d in sorted(date_stats.keys()):
            s = date_stats[d]
            status = 'OK' if s['mismatch'] == 0 else f"!! {s['mismatch']}筆不符"
            print(f"  {d:12s} {s['total']:5d} {s['match']:5d} {s['mismatch']:5d} {s['no_kline']:5d} {status}")

        # 不符明細（每類最多 15 筆）
        if cat_mismatches:
            # 分大差異和小差異
            big = [m for m in cat_mismatches if abs(m.get('diff_pct', 0)) >= 1.0]
            small = [m for m in cat_mismatches if abs(m.get('diff_pct', 0)) < 1.0]

            if big:
                print(f"\n  ** 大差異 (>=1%) — {len(big)} 筆 **")
                for m in big[:15]:
                    print(f"    {m['date']} {m['symbol']:12s} {m['name'][:8]:8s} "
                          f"掃描={m['scan_price']:>8} K線={m['kline_close']:>8} "
                          f"差={m['diff_pct']:+.2f}%")
                if len(big) > 15:
                    print(f"    ... 還有 {len(big) - 15} 筆")
            if small:
                print(f"\n  微差異 (<1%) — {len(small)} 筆（可能是四捨五入）")

        grand['total'] += cat['total']
        grand['match'] += cat['match']
        grand['mismatch'] += cat['mismatch']
        grand['no_kline'] += cat['no_kline']
        all_mismatches.extend(cat_mismatches)

    # 凍結價格偵測
    frozen = detect_frozen_prices(all_results_by_cat)
    if frozen:
        print(f"\n{'='*70}")
        print(f"  !! 凍結價格偵測 — 同一支股票多天掃描價格不變但K線已變 !!")
        print(f"  {'─'*66}")
        for fr in frozen:
            dates_str = ', '.join(fr['dates'])
            kline_str = ', '.join(str(k) for k in fr['kline_closes'])
            print(f"  [{fr['category']}] {fr['symbol']}")
            print(f"    凍結價: {fr['frozen_price']}  日期: {dates_str}")
            print(f"    實際K線: {kline_str}")

    # 匯總
    total_checked = grand['match'] + grand['mismatch']
    pct = grand['match'] / total_checked * 100 if total_checked > 0 else 0
    big_mismatches = [m for m in all_mismatches if abs(m.get('diff_pct', 0)) >= 1.0]
    small_mismatches = [m for m in all_mismatches if abs(m.get('diff_pct', 0)) < 1.0]

    print(f"\n{'='*70}")
    print(f"  ===  3 個月全面匯總  ===")
    print(f"  總檢查:     {grand['total']} 支")
    print(f"  價格正確:   {grand['match']}")
    print(f"  價格不符:   {grand['mismatch']}  (大差異>=1%: {len(big_mismatches)}, 微差異<1%: {len(small_mismatches)})")
    print(f"  無K線資料:  {grand['no_kline']}")
    print(f"  正確率:     {pct:.1f}%")
    print(f"  凍結價格:   {len(frozen)} 支股票")
    print(f"{'='*70}")

    # 按月份統計
    monthly = defaultdict(lambda: {'total': 0, 'match': 0, 'mismatch': 0})
    for m in all_mismatches:
        mon = m['date'][:7]
        monthly[mon]['mismatch'] += 1
    # 需要從 all_results_by_cat 重算
    for cat_name, results_list in all_results_by_cat.items():
        for res in results_list:
            mon = res['date'][:7]
            for rec in res['records']:
                monthly[mon]['total'] += 1
                if rec['status'] == 'match':
                    monthly[mon]['match'] += 1

    print(f"\n  === 按月份統計 ===")
    print(f"  {'月份':10s} {'檢查':>6s} {'正確':>6s} {'不符':>6s} {'正確率':>8s}")
    for mon in sorted(monthly.keys()):
        s = monthly[mon]
        checked = s['match'] + s['mismatch']
        rate = s['match'] / checked * 100 if checked > 0 else 0
        print(f"  {mon:10s} {s['total']:6d} {s['match']:6d} {s['mismatch']:6d} {rate:7.1f}%")


if __name__ == '__main__':
    main()
