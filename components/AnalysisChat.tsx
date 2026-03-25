'use client';

import { useState, useRef, useEffect } from 'react';
import { useReplayStore } from '@/store/replayStore';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

function MarkdownText({ text }: { text: string }) {
  // Simple markdown: bold (**text**), newlines → <br>
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

export default function AnalysisChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { allCandles, currentIndex, currentSignals, currentStock, currentInterval } = useReplayStore();

  // Build context from current state
  function buildContext(): string {
    const stock = currentStock
      ? `股票：${currentStock.name}（${currentStock.ticker}）`
      : '股票：未選擇';
    const interval = currentInterval
      ? `週期：${currentInterval === '1d' ? '日線' : currentInterval === '1wk' ? '週線' : '月線'}`
      : '';

    const c = allCandles[currentIndex];
    if (!c) return `${stock} ${interval}`;

    const prev = allCandles[currentIndex - 1];
    const chg = prev ? ((c.close - prev.close) / prev.close * 100).toFixed(2) : '—';

    const candleInfo = [
      `日期：${c.date}`,
      `開：${c.open.toFixed(2)}  高：${c.high.toFixed(2)}  低：${c.low.toFixed(2)}  收：${c.close.toFixed(2)}`,
      `漲跌幅：${chg}%`,
      `成交量：${(c.volume / 1000).toFixed(0)}K`,
      c.ma5  != null ? `MA5：${c.ma5.toFixed(2)}` : '',
      c.ma10 != null ? `MA10：${c.ma10.toFixed(2)}` : '',
      c.ma20 != null ? `MA20：${c.ma20.toFixed(2)}` : '',
      c.ma60 != null ? `MA60：${c.ma60.toFixed(2)}` : '',
      c.macdDIF  != null ? `MACD DIF：${c.macdDIF.toFixed(2)}` : '',
      c.macdSignal != null ? `MACD Signal：${c.macdSignal.toFixed(2)}` : '',
      c.macdOSC  != null ? `MACD OSC：${c.macdOSC.toFixed(2)}` : '',
      c.kdK != null ? `KD K：${c.kdK.toFixed(2)}` : '',
      c.kdD != null ? `KD D：${c.kdD.toFixed(2)}` : '',
    ].filter(Boolean).join('\n');

    const signals = currentSignals.length > 0
      ? `\n\n當前系統訊號：\n${currentSignals.map(s => `- [${s.type}] ${s.label}：${s.description}`).join('\n')}`
      : '\n\n當前無系統訊號';

    return `${stock}　${interval}\n\n當前K棒資料：\n${candleInfo}${signals}`;
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: 'user', content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    const assistantMsg: Message = { role: 'assistant', content: '' };
    setMessages([...nextMessages, assistantMsg]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages.map(m => ({ role: m.role, content: m.content })),
          context: buildContext(),
        }),
      });

      if (!res.ok || !res.body) throw new Error('Request failed');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: fullText };
          return copy;
        });
      }
    } catch {
      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: 'assistant', content: '❌ 連線失敗，請確認 API 金鑰已設定' };
        return copy;
      });
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function insertContext() {
    const ctx = buildContext();
    setInput(prev => prev ? `${prev}\n\n[當前走圖資訊]\n${ctx}` : `[當前走圖資訊]\n${ctx}\n\n請問：`);
    inputRef.current?.focus();
  }

  return (
    <div className="bg-slate-800 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-700/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-300">🤖 朱老師理論問答</span>
          {messages.length > 0 && (
            <span className="text-xs text-slate-500">{messages.length / 2 | 0} 則對話</span>
          )}
        </div>
        <span className="text-slate-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-700">
          {/* Messages */}
          <div className="h-72 overflow-y-auto p-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center py-8">
                <p className="text-slate-500 text-sm mb-2">有任何走圖問題，都可以問我！</p>
                <div className="flex flex-wrap justify-center gap-2 text-xs">
                  {[
                    '這個買點符合朱老師理論嗎？',
                    'MACD黃金交叉在哪？',
                    '現在是多頭還是空頭趨勢？',
                    '停損應該設在哪？',
                  ].map(q => (
                    <button
                      key={q}
                      onClick={() => { setInput(q); inputRef.current?.focus(); }}
                      className="px-2 py-1 bg-slate-700 text-slate-300 rounded hover:bg-slate-600 transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-200'
                }`}>
                  {m.role === 'assistant' && m.content === '' && loading ? (
                    <span className="text-slate-400 animate-pulse">思考中...</span>
                  ) : (
                    <MarkdownText text={m.content} />
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="border-t border-slate-700 p-3 space-y-2">
            <div className="flex gap-2">
              <button
                onClick={insertContext}
                className="text-xs px-2 py-1 bg-slate-700 text-slate-400 rounded hover:bg-slate-600 hover:text-slate-200 transition-colors whitespace-nowrap"
                title="插入當前K棒資訊到提問中"
              >
                📊 附上當前資訊
              </button>
              <button
                onClick={() => setMessages([])}
                className="text-xs px-2 py-1 bg-slate-700 text-slate-400 rounded hover:bg-slate-600 hover:text-red-400 transition-colors"
                title="清除對話"
              >
                🗑 清除
              </button>
            </div>
            <div className="flex gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="輸入問題（Enter 發送，Shift+Enter 換行）..."
                className="flex-1 bg-slate-900 text-slate-200 text-xs rounded px-3 py-2 resize-none outline-none border border-slate-600 focus:border-blue-500 placeholder-slate-500 min-h-[40px] max-h-24"
                rows={2}
                disabled={loading}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                className="px-3 py-2 bg-blue-600 text-white text-xs rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
              >
                送出
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
