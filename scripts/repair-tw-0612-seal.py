#!/usr/bin/env python3
"""一次性修復：2026-06-12 TW L1 封存被下載注入寫成亂值（全市場 ~780+ 檔）。
用 TWSE STOCK_DAY_ALL（上市）+ TPEx otc（上櫃）官方收盤把 06-12 那根換掉。
量單位 = 成交股數 ÷ 1000（與相鄰張數根一致）。
官方查不到且該根「跳動 >10.5%」=停牌/無量 → 刪掉那根。
"""
import json, glob, os, sys, urllib.request

TARGET = "2026-06-12"
DRY = "--apply" not in sys.argv

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(req, timeout=30))

def num(s):
    try:
        s = str(s).replace(",", "").replace("+", "").strip()
        if s in ("", "--", "---", "x", "X", "null"): return None
        return float(s)
    except: return None

print("抓 TWSE STOCK_DAY_ALL ...")
tw = fetch("https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json")
assert tw.get("date") == "20260612", f"TWSE date={tw.get('date')} 不是 06-12，停"
twmap = {}
# fields: 代號 名稱 成交股數 成交金額 開盤 最高 最低 收盤 漲跌 筆數
for r in tw["data"]:
    o, h, l, c, sh = num(r[4]), num(r[5]), num(r[6]), num(r[7]), num(r[2])
    if c is None: continue
    if o is None: o = c
    if h is None: h = max(o, c)
    if l is None: l = min(o, c)
    twmap[r[0]] = (o, h, l, c, sh or 0)

print("抓 TPEx otc ...")
tpx = fetch("https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=2026/06/12&type=EW&id=&response=json")
tpxmap = {}
# fields: 代號 名稱 收盤 漲跌 開盤 最高 最低 成交股數 ...
for r in tpx["tables"][0]["data"]:
    c, o, h, l, sh = num(r[2]), num(r[4]), num(r[5]), num(r[6]), num(r[7])
    if c is None: continue
    if o is None: o = c
    if h is None: h = max(o, c)
    if l is None: l = min(o, c)
    tpxmap[r[0]] = (o, h, l, c, sh or 0)

print(f"TWSE {len(twmap)} 檔 / TPEx {len(tpxmap)} 檔\n")

fixed = dropped = unchanged = nodata = 0
samples = []

for f in sorted(glob.glob("data/candles/TW/*.json")):
    base = os.path.basename(f)
    if base.endswith(".TWO.json"):
        code = base[:-9]; src = tpxmap
    elif base.endswith(".TW.json"):
        code = base[:-8]; src = twmap
    else:
        continue
    try:
        d = json.load(open(f))
    except: continue
    cs = d.get("candles")
    if not cs: continue
    idx = next((i for i, c in enumerate(cs) if c.get("date") == TARGET), None)
    if idx is None: continue
    prev_close = cs[idx-1]["close"] if idx > 0 and cs[idx-1].get("close") else None
    bar = cs[idx]

    off = src.get(code)
    if off:
        o, h, l, c, sh = off
        vol = round(sh / 1000)
        new = {"date": TARGET, "open": round(o, 2), "high": round(h, 2),
               "low": round(l, 2), "close": round(c, 2), "volume": vol}
        if (abs(bar.get("close", 0) - c) > 1e-6 or abs(bar.get("open", 0) - o) > 1e-6
                or bar.get("volume") != vol):
            cs[idx] = new
            fixed += 1
            if len(samples) < 12:
                samples.append(f"  {code}: 收 {bar.get('close')} → {c}  (量 {bar.get('volume')}→{vol})")
            if not DRY:
                json.dump(d, open(f, "w"), ensure_ascii=False)
        else:
            unchanged += 1
    else:
        # 官方無此檔：若該根明顯壞（>10.5% 跳動）→ 刪
        if prev_close and prev_close > 0 and bar.get("close"):
            r = bar["close"] / prev_close
            if r < 0.895 or r > 1.105:
                del cs[idx]
                d["lastDate"] = cs[-1]["date"] if cs else d.get("lastDate")
                if d.get("sealedDate") == TARGET:
                    d["sealedDate"] = cs[-1]["date"] if cs else None
                dropped += 1
                if not DRY:
                    json.dump(d, open(f, "w"), ensure_ascii=False)
            else:
                nodata += 1
        else:
            nodata += 1

print(f"{'[DRY-RUN] ' if DRY else '[APPLIED] '}修正 {fixed} / 刪壞根 {dropped} / 已正確 {unchanged} / 官方無資料保留 {nodata}")
print("\n抽樣:")
print("\n".join(samples))
if DRY:
    print("\n→ 確認無誤後加 --apply 實際寫入")
