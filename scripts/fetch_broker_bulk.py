#!/usr/bin/env python3
"""
主力分點 bulk 回填 — FinMind SponsorPro storage_objects 一次抓「整日全市場」分點 parquet。

取代逐檔慢請求（backfill-broker-deep.ts 一檔一天一抓、500檔×多天）：
  一個請求(跟307轉址下載) → 整日全市場 parquet(~20MB, ~2700檔, 300萬筆) → 一次算出所有股的主力分點。
  ⚠️ parquet 隔天才產出（當日傍晚還沒），故僅供回填/補洞；當日 live 仍走 Yahoo(snapshot-broker-tw)。

集中度公式與 backfill-broker-deep.ts / lib/inststeal 單一事實一致（已逐檔比對 byte 級相同）：
  每分點 Σ(buy-sell) → 前15正=topBuy、前15負abs=topSell
  netDifference(張)=round((topBuy-topSell)/1000)；concentration(%)=(topBuy-topSell)/totalBuy*100

用法：
  python3 scripts/fetch_broker_bulk.py --date 2026-06-17
  python3 scripts/fetch_broker_bulk.py --from 2026-06-13 --to 2026-06-18
  python3 scripts/fetch_broker_bulk.py --days 5            # 最近5交易日
  python3 scripts/fetch_broker_bulk.py --date 2026-06-17 --top500   # 只寫成交額前500
"""
import argparse, json, os, sys, tempfile, time, urllib.request, urllib.parse
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BROKER_DIR = os.path.join(ROOT, 'data', 'chips', 'TW', 'broker')
TWII = os.path.join(ROOT, 'data', 'candles', 'TW', '^TWII.json')
RANK = os.path.join(ROOT, 'data', 'turnover-rank', 'TW.json')


def load_token():
    p = os.path.join(ROOT, '.env.local')
    for line in open(p, encoding='utf-8'):
        if line.startswith('FINMIND_API_TOKEN='):
            return line.split('=', 1)[1].strip().strip('"').strip()
    raise SystemExit('找不到 FINMIND_API_TOKEN')


def trading_days(upto=None, frm=None, n=None):
    days = [c['date'] for c in json.load(open(TWII))['candles']]
    if frm: days = [d for d in days if d >= frm]
    if upto: days = [d for d in days if d <= upto]
    return days[-n:] if n else days


def download_parquet(token, date, tmp, retries=4):
    url = ('https://api.finmindtrade.com/api/v4/storage_objects?dataset=TaiwanStockTradingDailyReport'
           f'&date={date}&token={urllib.parse.quote(token)}')
    # urllib 自動跟 307 轉址到簽名 URL。transient 失敗會變資料洞 → 退避重試；空 body 才放棄。
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
            if data and len(data) >= 1000:
                with open(tmp, 'wb') as f:
                    f.write(data)
                return tmp
            return None  # 空=當日尚未產出/非交易日
        except Exception:
            if attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
    return None


def compute_day(parquet_path):
    import pandas as pd
    df = pd.read_parquet(parquet_path, columns=['stock_id', 'securities_trader_id', 'buy', 'sell'])
    df['net'] = df['buy'] - df['sell']
    # 每(股,分點)淨額 + 每股總買
    per = df.groupby(['stock_id', 'securities_trader_id'], sort=False)['net'].sum().reset_index()
    total_buy = df.groupby('stock_id', sort=False)['buy'].sum()
    out = {}
    for code, g in per.groupby('stock_id', sort=False):
        nets = g['net'].values
        top_buy = nets[nets > 0]
        top_sell = nets[nets < 0]
        top_buy = top_buy[top_buy.argsort()[::-1][:15]].sum() if len(top_buy) else 0
        top_sell = -top_sell[top_sell.argsort()[:15]].sum() if len(top_sell) else 0
        tb = float(total_buy.get(code, 0))
        if tb <= 0:
            continue
        out[code] = {
            'netDifference': round((top_buy - top_sell) / 1000),
            'concentration': round((top_buy - top_sell) / tb * 100, 2),
        }
    return out


def merge_write(code, date, bd):
    path = os.path.join(BROKER_DIR, f'{code}.json')
    data = []
    if os.path.exists(path):
        try:
            data = json.load(open(path)).get('data', [])
        except Exception:
            data = []
    m = {r['date']: r for r in data}
    m[date] = {'date': date, **bd}
    merged = sorted(m.values(), key=lambda r: r['date'])
    obj = {'symbol': code, 'market': 'TW', 'lastDate': merged[-1]['date'],
           'updatedAt': datetime.utcnow().isoformat() + 'Z', 'data': merged}
    fd, tmp = tempfile.mkstemp(dir=BROKER_DIR, suffix='.tmp')
    with os.fdopen(fd, 'w') as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date'); ap.add_argument('--from', dest='frm'); ap.add_argument('--to')
    ap.add_argument('--days', type=int); ap.add_argument('--top500', action='store_true')
    a = ap.parse_args()
    token = load_token()
    os.makedirs(BROKER_DIR, exist_ok=True)

    if a.date:
        dates = [a.date]
    elif a.frm or a.to:
        dates = trading_days(upto=a.to, frm=a.frm)
    elif a.days:
        dates = trading_days(n=a.days)
    else:
        dates = trading_days(n=1)

    pool = None
    if a.top500:
        pool = set(s.split('.')[0] for s in json.load(open(RANK))['symbols'])

    for date in dates:
        with tempfile.NamedTemporaryFile(suffix='.parquet', delete=False) as tf:
            tmp = tf.name
        try:
            if not download_parquet(token, date, tmp):
                print(f'⏭  {date}: 無 parquet（當日尚未產出/非交易日）')
                continue
            day = compute_day(tmp)
            written = 0
            for code, bd in day.items():
                if pool is not None and code not in pool:
                    continue
                merge_write(code, date, bd)
                written += 1
            print(f'✅ {date}: 全市場 {len(day)} 檔，寫入 {written} 檔'
                  + ('（限前500）' if pool else ''))
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


if __name__ == '__main__':
    main()
