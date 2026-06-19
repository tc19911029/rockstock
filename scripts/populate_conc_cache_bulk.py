#!/usr/bin/env python3
"""
集中度快取 bulk 灌入 — 從 FinMind SponsorPro 整日全市場分點 parquet 直接寫
`data/chips/TW/finmind-branch/{code}.json`（computeConc5Map 讀的快取）。

根因（2026-06-19 第三層洞）：掃描的「集中度在爬」用 computeConc5Map → fetchFinMindBranchDay
逐檔逐日抓；掃描並發高時 FinMind 大量非200 → strict 模式 silent 丟掉整檔（尤其上櫃）。
→ 合格的 Y軌候選（如 5314）被默默漏掉、掃出假的 0。

解法：bulk parquet 一次有全市場全分點 → 程式端算同一份快取格式 {date:{net:{券商id:淨張}, at:ms}}。
**公式完全不動**（concFromNets 在 query 時照算前15）；只是把「逐檔抓常失敗」換成「bulk 一次灌滿」。
net 單位＝張＝(buy-sell)/1000（與 FinMindBranchProvider 同口徑）。

用法：
  python3 scripts/populate_conc_cache_bulk.py --from 2026-06-05 --to 2026-06-18
  python3 scripts/populate_conc_cache_bulk.py --days 12 [--all]   # 預設只灌成交額前500，--all 全市場
"""
import argparse, json, os, tempfile, time, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, 'data', 'chips', 'TW', 'finmind-branch')
TWII = os.path.join(ROOT, 'data', 'candles', 'TW', '^TWII.json')
RANK = os.path.join(ROOT, 'data', 'turnover-rank', 'TW.json')
KEEP_DAYS = 60


def load_token():
    for line in open(os.path.join(ROOT, '.env.local'), encoding='utf-8'):
        if line.startswith('FINMIND_API_TOKEN='):
            return line.split('=', 1)[1].strip().strip('"').strip()
    raise SystemExit('找不到 FINMIND_API_TOKEN')


def trading_days(frm=None, to=None, n=None):
    days = [c['date'] for c in json.load(open(TWII))['candles']]
    if frm: days = [d for d in days if d >= frm]
    if to: days = [d for d in days if d <= to]
    return days[-n:] if n else days


def download_parquet(token, date, tmp, retries=4):
    url = ('https://api.finmindtrade.com/api/v4/storage_objects?dataset=TaiwanStockTradingDailyReport'
           f'&date={date}&token={urllib.parse.quote(token)}')
    # transient 下載失敗會變成快取洞 → 退避重試；真的沒 parquet(空 body) 才放棄。
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
            if data and len(data) >= 1000:
                with open(tmp, 'wb') as f:
                    f.write(data)
                return tmp
            return None  # 空 body = 該日真的沒 parquet（非交易日/未產出）
        except Exception:
            if attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
    return None  # 重試後仍失敗


def merge_cache(code, date, net_map, now_ms):
    path = os.path.join(CACHE_DIR, f'{code}.json')
    cache = {}
    if os.path.exists(path):
        try:
            cache = json.load(open(path))
        except Exception:
            cache = {}
    cache[date] = {'net': net_map, 'at': now_ms}
    # 只留最近 KEEP_DAYS 天（與 TS saveCache 同）
    dates = sorted(cache.keys())
    if len(dates) > KEEP_DAYS:
        for d in dates[:len(dates) - KEEP_DAYS]:
            del cache[d]
    fd, tmp = tempfile.mkstemp(dir=CACHE_DIR, suffix='.tmp')
    with os.fdopen(fd, 'w') as f:
        json.dump(cache, f, ensure_ascii=False)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='frm'); ap.add_argument('--to')
    ap.add_argument('--days', type=int); ap.add_argument('--all', action='store_true')
    a = ap.parse_args()
    token = load_token()
    os.makedirs(CACHE_DIR, exist_ok=True)
    import pandas as pd

    if a.frm or a.to:
        dates = trading_days(frm=a.frm, to=a.to)
    elif a.days:
        dates = trading_days(n=a.days)
    else:
        dates = trading_days(n=1)

    pool = None
    if not a.all:
        pool = set(s.split('.')[0] for s in json.load(open(RANK))['symbols'])

    now_ms = int(time.time() * 1000)
    for date in dates:
        with tempfile.NamedTemporaryFile(suffix='.parquet', delete=False) as tf:
            tmp = tf.name
        try:
            if not download_parquet(token, date, tmp):
                print(f'⏭  {date}: 無 parquet')
                continue
            df = pd.read_parquet(tmp, columns=['stock_id', 'securities_trader_id', 'buy', 'sell'])
            df['net'] = (df['buy'] - df['sell']) / 1000.0  # 股→張
            per = df.groupby(['stock_id', 'securities_trader_id'], sort=False)['net'].sum()
            written = 0
            for code, s in per.groupby(level=0, sort=False):
                if pool is not None and code not in pool:
                    continue
                # {券商id: 淨張}（去掉 0，省空間；concFromNets 對 0 無影響）
                net_map = {tid: round(float(v), 3) for (_, tid), v in s.items() if abs(v) > 1e-9}
                if not net_map:
                    continue
                merge_cache(code, date, net_map, now_ms)
                written += 1
            print(f'✅ {date}: 全市場 {per.index.get_level_values(0).nunique()} 檔，寫快取 {written} 檔'
                  + ('' if a.all else '（限前500）'))
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


if __name__ == '__main__':
    main()
