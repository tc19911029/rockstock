#!/usr/bin/env python3
"""
主力券商分點 — 用 FinMind Sponsor Pro「整天全市場 parquet」批量回填（快 200 倍）
  一天一個請求 → 整個市場 → 算每檔集中度=(前15買超-前15賣超)/成交量 → 存 data/chips/TW/broker/{code}.json
用法: python3 scripts/backfill_broker_bulk.py [from_date] [to_date]
"""
import subprocess, os, sys, json, tempfile
from collections import defaultdict
from datetime import datetime
import pyarrow.parquet as pq

ROOT = '/Users/tc/Desktop/rockstock'
BROKER_DIR = f'{ROOT}/data/chips/TW/broker'
TWII = f'{ROOT}/data/candles/TW/^TWII.json'

def token():
    for line in open(f'{ROOT}/.env.local'):
        if line.startswith('FINMIND_API_TOKEN='):
            return line.split('=', 1)[1].strip()
    raise SystemExit('no token')

def trading_days(frm, to):
    cs = json.load(open(TWII))['candles']
    return [c['date'] for c in cs if frm <= c['date'] <= to]

def fetch_parquet(date, tok):
    url = f'https://api.finmindtrade.com/api/v4/storage_objects?dataset=TaiwanStockTradingDailyReport&date={date}'
    tmp = tempfile.mktemp(suffix='.parquet')
    r = subprocess.run(['curl', '-sL', '--max-time', '180', '-H', f'Authorization: Bearer {tok}', url, '-o', tmp],
                       capture_output=True)
    if not os.path.exists(tmp) or os.path.getsize(tmp) < 1000:
        if os.path.exists(tmp): os.remove(tmp)
        return None
    return tmp

def main():
    frm = sys.argv[1] if len(sys.argv) > 1 else '2024-06-12'
    to = sys.argv[2] if len(sys.argv) > 2 else '2026-06-12'
    tok = token()
    days = trading_days(frm, to)
    print(f'分點 bulk 回填 {frm}~{to}，共 {len(days)} 天', flush=True)
    os.makedirs(BROKER_DIR, exist_ok=True)

    series = defaultdict(list)  # code -> [{date,netDifference,concentration}]

    def flush():
        for code, rows in series.items():
            # 合併既有(可續跑、不蓋掉舊區間)
            merged = {}
            fp = f'{BROKER_DIR}/{code}.json'
            if os.path.exists(fp):
                try:
                    for r in json.load(open(fp)).get('data', []):
                        merged[r['date']] = r
                except Exception:
                    pass
            for r in rows:
                merged[r['date']] = r
            out = sorted(merged.values(), key=lambda r: r['date'])
            json.dump({'symbol': code, 'market': 'TW', 'lastDate': out[-1]['date'],
                       'updatedAt': datetime.utcnow().isoformat() + 'Z', 'data': out},
                      open(fp, 'w'))
        print(f'  ↳ 存檔 {len(series)} 檔(已合併)', flush=True)

    import pandas as pd
    for i, date in enumerate(days):
        p = fetch_parquet(date, tok)
        if p is None:
            print(f'  {date} 無資料/跳過', flush=True); continue
        try:
            df = pq.read_table(p, columns=['stock_id', 'securities_trader_id', 'buy', 'sell']).to_pandas()
        except Exception as e:
            print(f'  {date} 壞檔跳過({str(e)[:40]})', flush=True); os.remove(p); continue
        os.remove(p)
        df['net'] = df['buy'] - df['sell']
        # 每檔×每分點 淨額
        per = df.groupby(['stock_id', 'securities_trader_id'], sort=False)['net'].sum()
        vol = df.groupby('stock_id', sort=False)['buy'].sum()
        for code, sub in per.groupby(level=0):
            if not (code.isdigit() and len(code) == 4):
                continue
            nets = sub.values
            buyers = nets[nets > 0]
            sellers = nets[nets < 0]
            top_buy = buyers[buyers.argsort()[-15:]].sum() if len(buyers) else 0
            top_sell = -sellers[sellers.argsort()[:15]].sum() if len(sellers) else 0
            v = vol[code]
            if v <= 0:
                continue
            conc = round((top_buy - top_sell) / v * 100, 2)
            series[code].append({'date': date, 'netDifference': int(round((top_buy - top_sell) / 1000)),
                                 'concentration': float(conc)})
        if (i + 1) % 20 == 0 or i < 2:
            print(f'  [{i+1}/{len(days)}] {date} 累計 {len(series)} 檔', flush=True)
        if (i + 1) % 60 == 0:
            flush()  # checkpoint 防中途死

    flush()
    print(f'完成：{len(series)} 檔股票寫入', flush=True)

main()
