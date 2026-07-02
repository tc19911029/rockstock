'use client';

/**
 * /smartmoney — 「股價在跌、但大戶逆勢偷買」每日清單
 *
 * 自創策略（隔離於 lib/smartmoney/，不進書本選股鏈路，守鐵則 #5）。
 * ⚠️ 2026-06-13 補完 3.5 年法人資料後回測證實「沒有超額」（原 +7.9%/勝83% 是 7 個月小樣本假象，
 *    已收回）→ 本頁標示為「未驗證·僅觀察」，不可當明牌（見 [[smartmoney_dip_strategy]]）。
 * 資料 = /api/smartmoney/list（lib/smartmoney 單一事實）。
 *
 * 版面（2026-06-14 重做）：滿版 + 密集股票卡片格（對齊首頁右側掃描卡的豐富感），
 * 不再用 max-w 窄欄置中（會一片空白）。
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader, Panel } from '@/components/shared';
import { bullBearClass } from '@/lib/format';

interface Hit {
  code: string; name: string; price: number;
  conc20: number; conc20prev: number; conc5: number; volRatio: number; drop5: number;
}
interface Day {
  date: string; generatedAt: string; universe: number;
  params: { shortWin: number; longWin: number; turnBack: number; longMin: number; longMax: number; shortMax: number; volRatioMax: number };
  hits: Hit[];
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-secondary/40 px-2.5 py-1.5">
      <div className="text-[10px] text-muted-foreground leading-tight">{label}</div>
      <div className={`text-sm font-mono tabular-nums font-semibold leading-tight ${tone ?? 'text-foreground'}`}>{value}</div>
    </div>
  );
}

function StockCard({ h }: { h: Hit }) {
  return (
    <Panel className="p-3 hover:ring-sky-500/40 transition-shadow">
      <div className="flex items-baseline justify-between gap-2">
        <Link href={`/?load=${h.code}.TW`} className="min-w-0 group">
          <span className="font-mono text-sky-400 group-hover:underline">{h.code}</span>{' '}
          <span className="font-medium group-hover:underline">{h.name}</span>
        </Link>
        <div className="text-right shrink-0">
          <div className="font-mono tabular-nums text-sm">{h.price}</div>
          <div className={`text-xs font-mono tabular-nums ${bullBearClass(h.drop5)}`}>近5日 {h.drop5.toFixed(1)}%</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5 mt-2.5">
        <Metric label="主力分點20日集中度" value={`+${h.conc20.toFixed(1)}%`} tone="text-bull" />
        <Metric label="5日集中度(濾隔日沖)" value={`${h.conc5.toFixed(1)}%`} tone={h.conc5 < 8 ? 'text-emerald-400' : 'text-yellow-400'} />
        <Metric label="量比(不爆量)" value={`${h.volRatio.toFixed(2)}x`} tone={h.volRatio < 1.8 ? 'text-muted-foreground' : 'text-yellow-400'} />
      </div>
    </Panel>
  );
}

export default function SmartMoneyPage() {
  const [day, setDay] = useState<Day | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const url = date ? `/api/smartmoney/list?date=${date}` : '/api/smartmoney/list';
    fetch(url)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { setErr(d.error || '載入失敗'); return; }
        setDay(d.day);
        setDates(d.availableDates || []);
        if (!date && d.date) setDate(d.date);
        setErr(null);
      })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [date]);

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="🕵️ 大戶偷買清單"
          subtitle={day ? `資料日 ${day.date} · 未驗證·僅觀察` : '未驗證·僅觀察'}
          backButton="/health?tab=market"
        />
      }
    >
      <div className="px-4 py-4 space-y-3">
        {/* 上方：誠實橫幅 + 說明 + 控制列（滿版，左右兩欄填滿寬度）*/}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 rounded-xl bg-amber-500/10 ring-1 ring-amber-500/30 px-4 py-3 text-sm">
            <div className="font-semibold text-amber-300 mb-1">⚠️ 這不是明牌（已被回測打臉）</div>
            <p className="text-foreground/90 leading-relaxed">
              補完 3.5 年完整法人資料後重測：這套「跌 + 大戶集中買」<b>沒有超額報酬</b>
              （原本 +7.9%/勝 83% 是 7 個月小樣本的運氣，已收回）。下面清單只當「觀察」用，<b>不要照著買</b>。
            </p>
          </div>
          <Panel className="px-4 py-3 text-sm flex flex-col justify-between gap-2">
            <p className="text-muted-foreground leading-relaxed text-xs">
              找「股價在跌、但三大法人逆勢一直買」的股票。條件：近 5 日跌 &gt;3% ＋ 法人 5 日籌碼集中度 &gt;8%。
              盤後算、隔天進場。<span className="text-bull">紅</span>=漲/強、<span className="text-bear">綠</span>=跌。
            </p>
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <label className="text-muted-foreground">資料日</label>
              <select
                value={date}
                onChange={e => setDate(e.target.value)}
                className="bg-secondary ring-1 ring-foreground/10 rounded px-2 py-1"
              >
                {dates.slice().reverse().map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              {day && (
                <span className="text-muted-foreground">
                  掃 {day.universe} · 命中 <b className="text-foreground">{day.hits.length}</b> 檔
                </span>
              )}
            </div>
          </Panel>
        </div>

        {loading && <div className="text-muted-foreground text-sm py-8 text-center animate-pulse">載入中…</div>}
        {err && <div className="text-rose-400 text-sm">錯誤：{err}</div>}

        {day && day.hits.length === 0 && (
          <Panel className="p-6 text-center text-sm text-muted-foreground">
            今天沒有符合的股票。（市場普漲時很常見：沒有「在跌」的股票 → 正常，不是壞掉。）
          </Panel>
        )}

        {/* 命中股票：滿版密集卡片格（手機 1 欄 / 平板 2 / 桌面 3 / 寬螢幕 4）*/}
        {day && day.hits.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {day.hits.map(h => <StockCard key={h.code} h={h} />)}
          </div>
        )}

        {/* 誠實警語 */}
        <div className="text-xs text-muted-foreground border-t border-border pt-3 leading-relaxed">
          ⚠️ 老實話：①回測只有 7 個月、又是大多頭，樣本短。②現在用「三大法人」當大戶代理，
          真正的「主力券商集中度」還在累積（主力分點欄多為 — ），過幾個月資料夠了會換成正版。
          ③這是觀察清單不是明牌，進場一定要守停損（跌 7-8% 出場）。
        </div>
      </div>
    </PageShell>
  );
}
