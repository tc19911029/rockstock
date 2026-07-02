#!/usr/bin/env python3
"""
AkShare 橋接 — 給陸股「真正的第二供應商」資料（EastMoney 之外）。

設計同 whisper/youtube 檔案橋接：Node spawn 此腳本、stdout 出乾淨 JSON、stderr 出進度/錯誤。
只接「AkShare 確實走非 EastMoney 源」的資料，否則沒有多源意義：
  --type financials  → ak.stock_financial_analysis_indicator（新浪，86 項財務指標）
                       回傳 eps/bps/roe/毛利率/净利率/营收YoY/净利YoY（無絕對营收净利，新浪只給比率）

例外（2026-06-12，cn-agents 漲停池備援）：zt/zb/dt/yzt 四個池子 akshare 底層也是抓
EastMoney，「多源」意義在於 akshare 的請求路徑/headers 與我們的 curlFetch 不同，
EM 直連被限流/擋 UA 時 akshare 常常仍通 — 是「同源不同管道」的備援而非真第二源。
  --type zt_pool          → ak.stock_zt_pool_em（漲停池，--code 傳 YYYYMMDD）
  --type zb_pool          → ak.stock_zt_pool_zbgc_em（炸板池，--code 傳 YYYYMMDD）
  --type dt_pool          → ak.stock_zt_pool_dtgc_em（跌停池，--code 傳 YYYYMMDD）
  --type yzt_pool         → ak.stock_zt_pool_previous_em（昨日漲停池，--code 傳 YYYYMMDD）
  --type market_activity  → ak.stock_market_activity_legu（乐咕乐股 漲跌家數，--code 傳 'now' 忽略）

池子輸出欄位刻意對齊 EM push2ex 原生欄名（c/n/zdp/p×1000/amount/ltsz/fund/fbt/lbt/zbc/
lbc/zttj/hybk），讓 TS 端（lib/cn-agents/datasource/emLimitUpPool.ts）一個 mapper 同時吃
EM 直連與本備援，不用兩套解析。

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


# ── cn-agents 漲停池系列（2026-06-12 加，EM push2ex 直連的備援管道） ──────────


def _str_or_none(v):
    """pandas 值 → str 或 None（nan/空 → None）。"""
    if v is None:
        return None
    s = str(v).strip()
    return None if s in ('', 'nan', 'None', '-') else s


def _hhmmss_int(v):
    """'092500' / 92500.0 → 92500（int），對齊 EM 原生 fbt/lbt 數字格式。"""
    s = _str_or_none(v)
    if s is None:
        return None
    s = s.split('.')[0]  # pandas 可能讀成 float '92500.0'
    return int(s) if s.isdigit() else None


def _p1000(v):
    """最新价（元）→ ×1000 int，對齊 EM 原生 p 欄位刻度。"""
    f = _num(v)
    return None if f is None else int(round(f * 1000))


def _zttj(v):
    """涨停统计 '6/4'（6 天 4 板）→ {'days': 6, 'ct': 4}，對齊 EM 原生 zttj 結構。"""
    s = _str_or_none(v)
    if s is None or '/' not in s:
        return None
    try:
        days, ct = s.split('/')
        return {'days': int(days), 'ct': int(ct)}
    except ValueError:
        return None


def _code6(v):
    """代码 → 6 位字串（pandas 偶把 '000631' 讀成 int 吃掉前導零）。"""
    return str(v).split('.')[0].zfill(6)


def zt_pool(code: str):
    """漲停池（code = YYYYMMDD）。欄位確認於 2026-06-12（akshare 1.18.64）。"""
    import akshare as ak
    df = ak.stock_zt_pool_em(date=code)
    if df is None or len(df) == 0:
        return []
    return [{
        'c': _code6(r['代码']),
        'n': _str_or_none(r['名称']),
        'zdp': _num(r['涨跌幅']),
        'p': _p1000(r['最新价']),
        'amount': _num(r['成交额']),
        'ltsz': _num(r['流通市值']),
        'fund': _num(r['封板资金']),
        'fbt': _hhmmss_int(r['首次封板时间']),
        'lbt': _hhmmss_int(r['最后封板时间']),
        'zbc': _num(r['炸板次数']),
        'lbc': _num(r['连板数']),
        'zttj': _zttj(r['涨停统计']),
        'hybk': _str_or_none(r['所属行业']),
    } for _, r in df.iterrows()]


def zb_pool(code: str):
    """炸板池（盤中觸停收盤未封回；code = YYYYMMDD）。"""
    import akshare as ak
    df = ak.stock_zt_pool_zbgc_em(date=code)
    if df is None or len(df) == 0:
        return []
    return [{
        'c': _code6(r['代码']),
        'n': _str_or_none(r['名称']),
        'zdp': _num(r['涨跌幅']),
        'p': _p1000(r['最新价']),
        'amount': _num(r['成交额']),
        'ltsz': _num(r['流通市值']),
        'fbt': _hhmmss_int(r['首次封板时间']),
        'zbc': _num(r['炸板次数']),
        'hybk': _str_or_none(r['所属行业']),
    } for _, r in df.iterrows()]


def dt_pool(code: str):
    """跌停池（code = YYYYMMDD）。days=连续跌停天數、oc=开板次数（對齊 EM 原生欄名）。"""
    import akshare as ak
    df = ak.stock_zt_pool_dtgc_em(date=code)
    if df is None or len(df) == 0:
        return []
    return [{
        'c': _code6(r['代码']),
        'n': _str_or_none(r['名称']),
        'zdp': _num(r['涨跌幅']),
        'p': _p1000(r['最新价']),
        'amount': _num(r['成交额']),
        'ltsz': _num(r['流通市值']),
        'fund': _num(r['封单资金']),
        'lbt': _hhmmss_int(r['最后封板时间']),
        'days': _num(r['连续跌停']),
        'oc': _num(r['开板次数']),
        'hybk': _str_or_none(r['所属行业']),
    } for _, r in df.iterrows()]


def yzt_pool(code: str):
    """昨日漲停池（今日表現；code = YYYYMMDD）。zdp = 今日漲跌幅 → 接力賺錢效應。"""
    import akshare as ak
    df = ak.stock_zt_pool_previous_em(date=code)
    if df is None or len(df) == 0:
        return []
    return [{
        'c': _code6(r['代码']),
        'n': _str_or_none(r['名称']),
        'zdp': _num(r['涨跌幅']),
        'p': _p1000(r['最新价']),
        'amount': _num(r['成交额']),
        'ltsz': _num(r['流通市值']),
        'zttj': _zttj(r['涨停统计']),
        'hybk': _str_or_none(r['所属行业']),
    } for _, r in df.iterrows()]


def market_activity(code: str):
    """全市場漲跌家數（乐咕乐股；code 忽略，慣例傳 'now'）。
    來源 df 是 item/value 直欄表，pivot 成單一 dict（data 陣列恆 1 筆）。"""
    import akshare as ak
    df = ak.stock_market_activity_legu()
    if df is None or len(df) == 0:
        return []
    kv = {str(r['item']).strip(): r['value'] for _, r in df.iterrows()}
    return [{
        'up': _num(kv.get('上涨')),
        'down': _num(kv.get('下跌')),
        'flat': _num(kv.get('平盘')),
        'limitUp': _num(kv.get('涨停')),
        'realLimitUp': _num(kv.get('真实涨停')),
        'limitDown': _num(kv.get('跌停')),
        'realLimitDown': _num(kv.get('真实跌停')),
        'suspended': _num(kv.get('停牌')),
        'statTime': _str_or_none(kv.get('统计日期')),
    }]


def news_em(code: str):
    """東財 7x24 全球財經快訊（code 忽略，慣例傳 'now'）。
    回 [{title, summary, publishTime, url}, ...]（新→舊，~200 條）。
    政策關鍵詞標記交給 TS 端做（單一事實），這裡只搬 raw。"""
    import akshare as ak
    df = ak.stock_info_global_em()
    if df is None or len(df) == 0:
        return []
    out = []
    for _, r in df.iterrows():
        out.append({
            'title': _str_or_none(r.get('标题')),
            'summary': _str_or_none(r.get('摘要')),
            'publishTime': _str_or_none(r.get('发布时间')),
            'url': _str_or_none(r.get('链接')),
        })
    return out


HANDLERS = {
    'financials': (financials, 'sina'),
    'zt_pool': (zt_pool, 'em-via-akshare'),
    'zb_pool': (zb_pool, 'em-via-akshare'),
    'dt_pool': (dt_pool, 'em-via-akshare'),
    'yzt_pool': (yzt_pool, 'em-via-akshare'),
    'market_activity': (market_activity, 'legu'),
    'news_em': (news_em, 'em-via-akshare'),
}


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
