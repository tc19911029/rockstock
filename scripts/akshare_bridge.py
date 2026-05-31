#!/usr/bin/env python3
"""
AkShare 橋接 — 給陸股「真正的第二供應商」資料（EastMoney 之外）。

設計同 whisper/youtube 檔案橋接：Node spawn 此腳本、stdout 出乾淨 JSON、stderr 出進度/錯誤。
只接「AkShare 確實走非 EastMoney 源」的資料，否則沒有多源意義：
  --type financials  → ak.stock_financial_analysis_indicator（新浪，86 項財務指標）
                       回傳 eps/bps/roe/毛利率/净利率/营收YoY/净利YoY（無絕對营收净利，新浪只給比率）

用法：python3 scripts/akshare_bridge.py --type financials --code 600519
輸出：{"ok": true, "source": "sina", "data": [ {...}, ... ]}（新→舊）或 {"ok": false, "error": "..."}
"""
import sys
import json
import argparse


def _num(v):
    """pandas 值 → float 或 None（nan/空 → None，確保合法 JSON）。"""
    try:
        import math
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def financials(code: str):
    import akshare as ak
    # 新浪財務指標（86 欄），start_year 取近 4 年
    from datetime import datetime
    start = str(datetime.now().year - 3)
    df = ak.stock_financial_analysis_indicator(symbol=code, start_year=start)
    if df is None or len(df) == 0:
        return []
    cols = set(df.columns)

    def col(name):
        return name if name in cols else None

    cmap = {
        'reportDate': '日期',
        'eps': '加权每股收益(元)',
        'bps': '每股净资产_调整后(元)',
        'roe': '加权净资产收益率(%)',
        'netMargin': '销售净利率(%)',
        'grossMargin': '销售毛利率(%)',
        'revenueYoY': '主营业务收入增长率(%)',
        'netProfitYoY': '净利润增长率(%)',
        'opCashPerShare': '每股经营性现金流(元)',
    }
    out = []
    for _, r in df.iterrows():
        rec = {}
        for k, c in cmap.items():
            if c not in cols:
                rec[k] = None
            elif k == 'reportDate':
                rec[k] = str(r[c])[:10]
            else:
                rec[k] = _num(r[c])
        out.append(rec)
    out.sort(key=lambda x: x['reportDate'] or '', reverse=True)  # 新→舊
    return out


HANDLERS = {'financials': (financials, 'sina')}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--type', required=True, choices=list(HANDLERS.keys()))
    ap.add_argument('--code', required=True)
    args = ap.parse_args()
    fn, source = HANDLERS[args.type]
    try:
        data = fn(args.code)
        print(json.dumps({'ok': True, 'source': source, 'data': data}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({'ok': False, 'error': str(e)[:200]}, ensure_ascii=False))
        sys.exit(0)  # 不丟非零，讓 Node 解析 error 欄而非當 spawn 失敗


if __name__ == '__main__':
    main()
