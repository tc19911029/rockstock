#!/usr/bin/env python3
"""
兩市成交額歷史回填來源 — 上交所/深交所官方每日概况（非 push2his，不受其封鎖影響）。

push2his.eastmoney.com 批量封鎖期間（2026-06），歷史「兩市成交額」抓不到。
改用交易所官方匯總（akshare 走 sse.com.cn / szse.cn）：
  - 上交所：ak.stock_sse_deal_daily(date) 的「成交金額·股票」欄（單位 億元 → ×1e8）
  - 深交所：ak.stock_szse_summary(date) 的「證券類別=股票」成交金額（單位 元）
兩者相加 = 兩市股票成交額，與線上 cron 的 push2 ulist f6 口徑一致
（實測 2026-06-12：本法 3.22 兆 vs cron 3.21 兆，差異為 ETF/基金含括）。

用法：python3 scripts/cn_market_turnover.py 20240603,20240604,...
輸出：{"ok": true, "data": {"2024-06-03": 1234567890123.0, ...}}（單位 元；抓不到的日期略過）
"""
import sys
import json


def sse_stock_turnover_cny(date_ymd8: str):
    import akshare as ak
    df = ak.stock_sse_deal_daily(date=date_ymd8)
    row = df[df['单日情况'] == '成交金额']
    if len(row) == 0:
        return None
    # 「股票」欄 = 主板A + 主板B + 科创板 合計，單位億元
    return float(row['股票'].values[0]) * 1e8


def szse_stock_turnover_cny(date_ymd8: str):
    import akshare as ak
    df = ak.stock_szse_summary(date=date_ymd8)
    row = df[df['证券类别'] == '股票']
    if len(row) == 0:
        return None
    return float(row['成交金额'].values[0])  # 已是元


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'error': 'no dates'}))
        return
    dates = [d.strip() for d in sys.argv[1].split(',') if d.strip()]
    out = {}
    for iso in dates:
        ymd8 = iso.replace('-', '')
        try:
            sse = sse_stock_turnover_cny(ymd8)
            szse = szse_stock_turnover_cny(ymd8)
            if sse is None or szse is None:
                continue
            total = sse + szse
            if total > 0:
                out[iso] = total
        except Exception as e:  # noqa: BLE001 — 單日失敗（停牌/假日/源異常）略過，不中斷整批
            sys.stderr.write(f'{iso} skip: {str(e)[:80]}\n')
    print(json.dumps({'ok': True, 'data': out}, ensure_ascii=False))


if __name__ == '__main__':
    main()
