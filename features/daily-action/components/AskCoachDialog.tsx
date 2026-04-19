'use client';

import { useEffect, useRef, useState } from 'react';
import type { DailyActionList, HoldingMonitor, BuyRecommendation } from '@/lib/portfolio/types';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface AskCoachDialogProps {
  data: DailyActionList;
  /** 焦點項目：點某檔的「💬 問老師」會帶這個進來，前置一段「請聚焦在 XXX」 */
  focusItem?:
    | { kind: 'holding'; holding: HoldingMonitor }
    | { kind: 'buy'; rec: BuyRecommendation };
  onClose: () => void;
}

const QUICK_QUESTIONS_GLOBAL = [
  '今天整體該怎麼操作？',
  '為什麼推薦的第一檔比第二檔好？',
  '我手上的股票要繼續抱還是出場？',
  '現在是進場好時機嗎？',
];

const QUICK_QUESTIONS_HOLDING = [
  '為什麼系統建議賣出這檔？',
  '我可以加碼嗎？',
  '停損價合理嗎？',
  '如果現在出場會少賺多少？',
];

const QUICK_QUESTIONS_BUY = [
  '為什麼這檔上推薦清單？',
  '建議部位 X 萬合理嗎？',
  '進場價要等回檔還是現在追？',
  '同類型還有什麼選擇？',
];

/**
 * 把 DailyActionList 整理成 LLM 能讀懂的中文摘要
 */
function buildContext(data: DailyActionList, focus?: AskCoachDialogProps['focusItem']): string {
  const lines: string[] = [];
  lines.push(`[每日操作清單 — 資料截止 ${data.asOfDate}]`);

  if (data.accounts.length > 0) {
    lines.push('');
    lines.push('## 帳戶現況');
    for (const a of data.accounts) {
      const tag = a.market === 'TW' ? '🇹🇼 台股' : '🇨🇳 陸股';
      lines.push(`${tag}：總值 ${a.totalCapital.toLocaleString()}、持倉 ${a.invested.toLocaleString()}、現金 ${a.cashBalance.toLocaleString()}、可買 ${a.cashAvailable.toLocaleString()}、未實現 ${a.unrealizedPL >= 0 ? '+' : ''}${a.unrealizedPL.toLocaleString()} (${a.unrealizedPLPct.toFixed(2)}%)`);
    }
  }

  // 持倉狀態
  if (data.holdings.length > 0) {
    lines.push('');
    lines.push('## 持倉監控');
    for (const h of data.holdings) {
      lines.push(`- ${h.symbol} ${h.name} (${h.market})：成本 ${h.costPrice}，現價 ${h.currentPrice}，停損 ${h.stopLossPrice} (距離 ${h.stopLossDistancePct.toFixed(2)}%)，損益 ${h.unrealizedPL >= 0 ? '+' : ''}${h.unrealizedPL.toLocaleString()} (${h.unrealizedPLPct.toFixed(2)}%)，建議：${h.action}${h.reasons[0] ? ` — ${h.reasons[0]}` : ''}`);
    }
  }

  // 買進建議
  if (data.buyRecommendations.length > 0) {
    lines.push('');
    lines.push('## 今日建議買進');
    for (const r of data.buyRecommendations) {
      lines.push(`#${r.rank} ${r.symbol} ${r.name} (${r.market})：進場 ${r.entryPrice}、停損 ${r.stopLossPrice}、建議 ${r.suggestedShares} 股 / ${r.suggestedAmount.toLocaleString()} 元 (${r.positionPct}%)、風險 ${r.riskAmount.toLocaleString()}`);
      if (r.reasons.length > 0) {
        for (const reason of r.reasons) lines.push(`   ・${reason}`);
      }
    }
  }

  // 觀察清單
  if (data.watchList.length > 0) {
    lines.push('');
    lines.push('## 候選觀察（資金/額度滿）');
    for (const w of data.watchList) {
      lines.push(`- ${w.symbol} ${w.name} (${w.market})：${w.currentPrice} ・ ${w.reason}`);
    }
  }

  // 焦點項目
  if (focus?.kind === 'holding') {
    lines.push('');
    lines.push(`## 使用者特別關心：${focus.holding.symbol} ${focus.holding.name}`);
    lines.push(`目前狀態：${focus.holding.action}，${focus.holding.reasons.join('；') || '無特殊狀況'}`);
    if (focus.holding.warnings.length > 0) lines.push(`警示：${focus.holding.warnings.join('；')}`);
  } else if (focus?.kind === 'buy') {
    lines.push('');
    lines.push(`## 使用者特別關心：${focus.rec.symbol} ${focus.rec.name}（買進建議 #${focus.rec.rank}）`);
    lines.push(`進場理由：${focus.rec.reasons.join('；')}`);
  }

  return lines.join('\n');
}

function MarkdownText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return part.split('\n').map((line, j, arr) => (
          <span key={`${i}-${j}`}>
            {line}
            {j < arr.length - 1 && <br />}
          </span>
        ));
      })}
    </>
  );
}

export function AskCoachDialog({ data, focusItem, onClose }: AskCoachDialogProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Esc 關閉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const quickQuestions = focusItem?.kind === 'holding'
    ? QUICK_QUESTIONS_HOLDING
    : focusItem?.kind === 'buy'
    ? QUICK_QUESTIONS_BUY
    : QUICK_QUESTIONS_GLOBAL;

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;
    const userMsg: Message = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);
    setError(null);

    // 預先放一個空的 assistant 訊息，邊收 stream 邊填
    setMessages([...newMessages, { role: 'assistant', content: '' }]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          context: buildContext(data, focusItem),
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = '';
      // Stream loop
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value, { stream: true });
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: assistantText };
          return copy;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  const focusLabel = focusItem?.kind === 'holding'
    ? `針對 ${focusItem.holding.symbol} ${focusItem.holding.name}`
    : focusItem?.kind === 'buy'
    ? `針對 ${focusItem.rec.symbol} ${focusItem.rec.name}（建議買進 #${focusItem.rec.rank}）`
    : '針對今日整體操作清單';

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-2"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-[640px] max-w-[98vw] h-[80vh] max-h-[720px] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h2 className="text-sm font-bold text-foreground">💬 問朱老師教練</h2>
            <p className="text-[10px] text-muted-foreground mt-0.5">{focusLabel}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none px-2">×</button>
        </div>

        {/* Messages */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && !loading && (
            <div className="text-center space-y-2">
              <div className="text-xs text-muted-foreground">系統已自動把今日操作清單帶給老師。直接問，或從下面選一題：</div>
              <div className="flex flex-wrap gap-1.5 justify-center pt-2">
                {quickQuestions.map(q => (
                  <button
                    key={q}
                    onClick={() => sendMessage(q)}
                    className="px-2 py-1 text-[11px] bg-secondary/60 hover:bg-secondary text-foreground rounded border border-border"
                  >{q}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] px-3 py-2 rounded-lg text-xs leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-blue-500/80 text-white'
                    : 'bg-secondary/60 text-foreground border border-border'
                }`}
              >
                {m.content
                  ? <MarkdownText text={m.content} />
                  : <span className="text-muted-foreground animate-pulse">老師思考中…</span>}
              </div>
            </div>
          ))}

          {error && (
            <div className="text-red-400 text-xs border border-red-500/40 rounded p-2">
              錯誤：{error}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="shrink-0 border-t border-border px-3 py-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={loading ? '老師回覆中…按 Enter 送出 (Shift+Enter 換行)' : '輸入你的問題（Enter 送出，Shift+Enter 換行）'}
            disabled={loading}
            rows={2}
            className="w-full px-2 py-1.5 bg-secondary/40 border border-border rounded text-xs text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <div className="flex items-center justify-between mt-1.5 text-[10px] text-muted-foreground">
            <span>朱老師六本書知識</span>
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || loading}
              className="px-2.5 py-1 bg-blue-500/80 hover:bg-blue-500 disabled:opacity-40 text-white rounded text-xs"
            >送出</button>
          </div>
        </div>
      </div>
    </div>
  );
}
