'use client';

/**
 * BrokerNewsSection — 首頁法人報告面板的「📰 同日消息面」折疊區。
 *
 * 顯示當日晨報新聞點到、且與持股/法人報告交叉的個股 + 交叉訊號（印證/矛盾/觀察）。
 */

import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { NewsDigest, NewsMention } from '@/lib/broker/newsDigest';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

interface Props {
  date: string;
  onSelectStock?: (code: string) => void;
}

const SENT: Record<string, { label: string; cls: string }> = {
  bullish: { label: '偏多', cls: 'text-bull' },
  bearish: { label: '偏空', cls: 'text-bear' },
  neutral: { label: '中性', cls: 'text-muted-foreground' },
};

export function BrokerNewsSection({ date, onSelectStock }: Props) {
  const [digest, setDigest] = useState<NewsDigest | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDigest(null);
    setMessage(null);
    fetch(`/api/broker/news-digest/${encodeURIComponent(date)}`)
      .then(r => r.json())
      .then((j: { digest: NewsDigest | null; message?: string }) => {
        if (!cancelled) { setDigest(j.digest); setMessage(j.message ?? null); }
      })
      .catch(() => { if (!cancelled) setMessage('消息面讀取失敗'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  if (loading) return <div role="status" className="shrink-0 border-b border-border/60 px-2 py-1.5 text-[10px] text-muted-foreground">讀取 {date} 消息面…</div>;
  if (!digest || digest.mentions.length === 0) return (
    <div className="shrink-0 border-b border-border/60 px-2 py-1.5 text-[10px] text-muted-foreground">
      {date} {message ?? '無可交叉比對的消息面資料'}
    </div>
  );

  const holding = digest.mentions.filter(m => m.in_holdings);
  const broker = digest.mentions.filter(m => !m.in_holdings && m.in_broker_reports);
  const fresh = digest.mentions.filter(m => !m.in_holdings && !m.in_broker_reports);

  const row = (m: NewsMention) => (
    <div
      key={m.code}
      className={`border-l-2 border-border/60 pl-2 py-1 ${m.market === 'TW' ? 'cursor-pointer hover:bg-secondary/30' : ''}`}
      onClick={() => m.market === 'TW' && onSelectStock?.(m.code)}
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] text-foreground/80">{stockDisplayName(m.name, m.code)}</span>
        <span className="font-mono text-[11px] text-foreground/60">{m.code}</span>
        <span className={`text-[9px] font-bold ${SENT[m.sentiment]?.cls}`}>{SENT[m.sentiment]?.label}</span>
        {m.in_holdings && <span className="text-[9px] px-1 rounded bg-amber-900/50 text-amber-300">持股</span>}
        {m.broker_view && <span className="text-[9px] text-muted-foreground ml-auto truncate max-w-[150px]" title={m.broker_view}>法人：{m.broker_view}</span>}
      </div>
      {m.cross_signal && (
        <div className="text-[10px] text-foreground/70 mt-0.5">{m.cross_signal}</div>
      )}
      {m.headlines.length > 0 && (
        <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2" title={m.headlines.join('\n')}>
          {m.headlines.map((h, i) => <span key={i}>{i > 0 && '・'}{h}</span>)}
        </div>
      )}
    </div>
  );

  return (
    <div className="shrink-0 border-b border-border/60 bg-secondary/20">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/40 transition-colors"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span>📰 {digest.date} 同日消息面</span>
        <span className="text-[9px] px-1 rounded bg-secondary text-muted-foreground font-normal">{digest.mentions.length} 檔</span>
        {holding.length > 0 && <span className="text-[9px] px-1 rounded bg-amber-900/50 text-amber-300 font-normal">持股 {holding.length}</span>}
        <span className="ml-auto text-[10px] font-normal text-muted-foreground">晨報 × 法人/持股</span>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1.5 text-[11px]">
          {holding.length > 0 && (
            <div>
              <div className="text-[9px] text-amber-300 font-semibold mb-0.5">持股同日上新聞</div>
              {holding.map(row)}
            </div>
          )}
          <div>
            <div className="text-[9px] text-sky-300 font-semibold mb-0.5">法人報告股同日上新聞（{broker.length}）</div>
            {broker.length ? broker.map(row) : <div className="text-muted-foreground text-[10px]">無</div>}
          </div>
          {fresh.length > 0 && (
            <div>
              <div className="text-[9px] text-emerald-300 font-semibold mb-0.5">新聞熱、法人報告未收錄（可觀察）</div>
              {fresh.map(row)}
            </div>
          )}
          <div className="text-[9px] text-muted-foreground border-t border-border/40 pt-1">
            來源：{digest.source}　·　持股命中 {digest.stats.holdings_hit}／法人報告命中 {digest.stats.broker_report_hit}
          </div>
        </div>
      )}
    </div>
  );
}
