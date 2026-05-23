'use client';

/**
 * /mockup — 統一排版規格預覽頁
 *
 * 用途：對照首頁 (`/`) 的排版細節，給使用者預覽所有頁面要對齊的視覺規格。
 * Approve 後逐步套用到 backtest/memory/portfolio/youtube/agents 等頁。
 * 全部 migration 完成後此檔案會被刪除（or 留作內部 reference）。
 */

import { useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader, EmptyState } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { RefreshCw, Download, Plus, Trash2, AlertTriangle } from 'lucide-react';

export default function MockupPage() {
  const [selected, setSelected] = useState<string | null>('TSMC');

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="🎨 排版規格預覽"
          backButton
          subtitle="統一 design system mockup"
          actions={
            <>
              <Button variant="secondary" size="sm">
                <RefreshCw className="w-3 h-3" />
                <span className="hidden sm:inline">刷新</span>
              </Button>
              <Button size="sm">
                <Download className="w-3 h-3" />
                <span className="hidden sm:inline">匯出</span>
              </Button>
            </>
          }
        />
      }
    >
      <div className="max-w-6xl mx-auto p-3 sm:p-4 space-y-6">

        {/* ─────────── Intro banner ─────────── */}
        <div className="border border-sky-500/40 bg-sky-500/10 text-sky-300 rounded-lg p-3 text-sm">
          <div className="font-semibold mb-1">💡 這是 mockup 頁</div>
          <div className="text-xs text-sky-200/80">
            這頁不接任何資料，純粹展示「首頁排版 DNA」的可重用樣板。
            底下每個 section 都對應一份 spec，套到 backtest/memory/youtube/agents 等頁時依此規格實作。
            Approve 後可以開始 migration；全部完成後此頁會被刪除（或保留作為設計 reference）。
          </div>
        </div>

        {/* ─────────── Section 1: PageHeader 變體 ─────────── */}
        <Section title="① PageHeader 三種樣板" caption="上方那條 sticky header 就是這個元件，所有頁面都要用">
          <Card>
            <div className="space-y-3 text-xs">
              <Row label="基本" code={`<PageHeader title="📊 報表" backButton />`}>
                <MockHeader title="📊 報表" />
              </Row>
              <Row label="含 subtitle" code={`title + subtitle="32 檔 · 2026-05-23"`}>
                <MockHeader title="🤖 多代理決策中心" subtitle="32 檔 · 2026-05-23" />
              </Row>
              <Row label="含 actions" code={`actions={<RefreshBtn />}`}>
                <MockHeader
                  title="⭐ 自選股"
                  subtitle="14 支"
                  actions={
                    <>
                      <Button variant="secondary" size="sm"><RefreshCw className="w-3 h-3" /></Button>
                      <Button size="sm"><Plus className="w-3 h-3" /></Button>
                    </>
                  }
                />
              </Row>
            </div>
          </Card>
        </Section>

        {/* ─────────── Section 2: 卡片樣式 ─────────── */}
        <Section title="② 卡片樣式" caption="所有 panel / list / nested / empty 都用這四種">

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

            {/* 主面板 */}
            <Card>
              <CardLabel
                tag="主面板"
                code="bg-card border border-border rounded-xl p-4"
              />
              <div className="text-xs font-semibold tracking-wider text-foreground mb-3">▸ Section heading</div>
              <div className="text-xs text-muted-foreground leading-relaxed">
                這是主面板 — 報表卡、結果區、設定區都用這個。
                Background 是 <code className="text-sky-400 font-mono">bg-card</code>，
                border 是 <code className="text-sky-400 font-mono">border-border</code>，
                radius 是 <code className="text-sky-400 font-mono">rounded-xl</code>。
              </div>
              <Divider />
              <div className="text-xs text-muted-foreground/80">底部 footer 文字用 muted-foreground/80</div>
            </Card>

            {/* 列表卡 */}
            <div className="bg-secondary border border-border rounded-xl overflow-hidden">
              <CardLabel
                tag="列表卡"
                code="bg-secondary border border-border rounded-xl overflow-hidden"
                inset
              />
              <div className="px-4 pb-2">
                <div className="text-xs text-muted-foreground mb-2">每筆獨立可點 row：</div>
              </div>
              {['2330 台積電', '2317 鴻海', '2454 聯發科'].map(s => (
                <button
                  key={s}
                  onClick={() => setSelected(s)}
                  className={`w-full px-4 py-2.5 text-left text-xs border-t border-border/60 transition-colors cursor-pointer ${
                    selected === s ? 'bg-sky-500/10 text-sky-300' : 'hover:bg-muted/40 text-foreground'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{s}</span>
                    <span className="text-muted-foreground tabular-nums">+1.42%</span>
                  </div>
                </button>
              ))}
            </div>

            {/* Nested card */}
            <Card>
              <CardLabel
                tag="主面板"
                code="bg-card 內部包 nested card"
              />
              <div className="text-xs text-muted-foreground mb-2">內層巢狀卡：</div>
              <div className="bg-muted/50 border border-border/60 rounded-lg p-3 space-y-1">
                <div className="text-xs font-semibold text-foreground">Nested card</div>
                <div className="text-xs text-muted-foreground">
                  <code className="text-sky-400 font-mono">bg-muted/50 border-border/60 rounded-lg p-3</code>
                </div>
                <div className="text-xs text-muted-foreground">用於主面板內的分組、回放細節、解析步驟等</div>
              </div>
            </Card>

            {/* Empty state */}
            <div className="bg-card border border-border rounded-xl p-4 flex flex-col">
              <CardLabel
                tag="空狀態"
                code="border-2 border-dashed border-border"
              />
              <div className="flex-1 flex items-center justify-center">
                <EmptyState
                  variant="compact"
                  icon="📋"
                  title="尚無資料"
                  description="觸發 cron 或選擇日期區間"
                />
              </div>
            </div>

          </div>
        </Section>

        {/* ─────────── Section 3: Banner 四種 ─────────── */}
        <Section title="③ Banner（狀態橫條）" caption="info / warning / error / §0 紅線">
          <Card>
            <div className="space-y-2">
              <BannerLabel code='border-sky-500/40 bg-sky-500/10 text-sky-300' />
              <div className="border border-sky-500/40 bg-sky-500/10 text-sky-300 rounded-lg p-3 text-sm">
                ✅ 已準備 32 檔。請在 Claude Code 對話執行 /multi-agent-decide
              </div>

              <BannerLabel code='border-yellow-500/30 bg-yellow-500/10 text-yellow-300' />
              <div className="border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 rounded-lg p-3 text-sm">
                ⚠ 此 analysis 是手動填的示範資料，不是真實 /youtube-analysis skill 跑出來的
              </div>

              <BannerLabel code='border-red-700/50 bg-red-900/30 text-red-300' />
              <div className="border border-red-700/50 bg-red-900/30 text-red-300 rounded-lg p-3 text-sm">
                ⛔ HTTP 500 — fetch failed
              </div>

              <BannerLabel code='§0 紅線：border-l-4 border-red-500 bg-red-900/20 text-red-300' />
              <div className="border-l-4 border-red-500 bg-red-900/20 text-red-300 rounded-r-lg p-3 text-xs">
                <strong>§0 紅線提醒：</strong>memory 是純文字觀察報告，<strong>不會被</strong> 任何 prepare/skill 讀取。
                如果報告顯示某 agent 命中率偏低，請<strong>使用者親手</strong>修改 source。
              </div>
            </div>
          </Card>
        </Section>

        {/* ─────────── Section 4: 表格 ─────────── */}
        <Section title="④ 表格" caption="thead 不再用 bg-gray-100；用 text-muted-foreground + border-b">
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b border-border">
                  <tr className="text-left">
                    <th className="py-2 pr-2">Action</th>
                    <th className="py-2 pr-2 text-center">樣本</th>
                    <th className="py-2 pr-2 text-right">avg d1</th>
                    <th className="py-2 pr-2 text-right">avg d5</th>
                    <th className="py-2 pr-2 text-right">avg d20</th>
                    <th className="py-2 pr-2 text-right">勝率 d5</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border/40 hover:bg-muted/30 bg-emerald-900/10">
                    <td className="py-2 pr-2 font-semibold text-emerald-300">BUY</td>
                    <td className="py-2 pr-2 text-center font-mono">128</td>
                    <td className="py-2 pr-2 text-right font-mono text-emerald-400">+1.24%</td>
                    <td className="py-2 pr-2 text-right font-mono text-emerald-400">+3.18%</td>
                    <td className="py-2 pr-2 text-right font-mono text-emerald-400">+8.42%</td>
                    <td className="py-2 pr-2 text-right font-mono">64.2%</td>
                  </tr>
                  <tr className="border-b border-border/40 hover:bg-muted/30 bg-amber-900/10">
                    <td className="py-2 pr-2 font-semibold text-amber-300">WATCH</td>
                    <td className="py-2 pr-2 text-center font-mono">47</td>
                    <td className="py-2 pr-2 text-right font-mono">+0.43%</td>
                    <td className="py-2 pr-2 text-right font-mono">+1.02%</td>
                    <td className="py-2 pr-2 text-right font-mono">+2.18%</td>
                    <td className="py-2 pr-2 text-right font-mono">52.1%</td>
                  </tr>
                  <tr className="border-b border-border/40 hover:bg-muted/30 bg-rose-900/10">
                    <td className="py-2 pr-2 font-semibold text-rose-300">SKIP</td>
                    <td className="py-2 pr-2 text-center font-mono">203</td>
                    <td className="py-2 pr-2 text-right font-mono text-rose-400">-0.18%</td>
                    <td className="py-2 pr-2 text-right font-mono text-rose-400">-0.42%</td>
                    <td className="py-2 pr-2 text-right font-mono text-rose-400">-1.04%</td>
                    <td className="py-2 pr-2 text-right font-mono">38.4%</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="text-[10px] text-muted-foreground mt-2">
              注意：行底色用 <code className="text-sky-400 font-mono">bg-emerald-900/10</code>{' '}
              不是 <code className="text-rose-400 font-mono">bg-green-50</code>（後者 dark mode 看不見）
            </div>
          </Card>
        </Section>

        {/* ─────────── Section 5: Buttons ─────────── */}
        <Section title="⑤ 按鈕（shadcn Button 元件）" caption="不要再寫 raw <button className='border rounded px-3 py-1 bg-blue-50'>">
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <Button>Default (primary)</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive"><Trash2 className="w-3 h-3" /> Destructive</Button>
              <Button variant="link">Link</Button>
            </div>
            <Divider />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs">xs</Button>
              <Button size="sm">sm</Button>
              <Button size="default">default</Button>
              <Button size="lg">lg</Button>
              <Button size="icon"><RefreshCw className="w-4 h-4" /></Button>
            </div>
            <Divider />
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled>Disabled</Button>
              <Button variant="secondary" disabled>Disabled secondary</Button>
            </div>
          </Card>
        </Section>

        {/* ─────────── Section 6: Before / After ─────────── */}
        <Section title="⑥ Before / After 對照" caption="現有 backtest 的 light theme vs 套上規格後">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

            {/* Before */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-rose-400 tracking-wider">❌ BEFORE — 現有 /agents/backtest</div>
              <BeforeBacktest />
            </div>

            {/* After */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-emerald-400 tracking-wider">✅ AFTER — 套上規格</div>
              <AfterBacktest />
            </div>
          </div>
        </Section>

        {/* ─────────── Bottom CTA ─────────── */}
        <div className="border-l-4 border-sky-500 bg-sky-500/10 text-sky-200 rounded-r-lg p-4 text-sm">
          <div className="font-semibold mb-1">確認 mockup 後</div>
          <div className="text-xs text-sky-100/80 leading-relaxed">
            告訴我 OK 就開始 migration（Step 1：/agents/backtest）。
            如果有想調整的細節（例如顏色、間距、字級）也直接說，我會更新 spec 再套。
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Link
              href="/agents/backtest"
              className="text-xs text-sky-400 hover:text-sky-300 underline"
            >
              對照看現有 /agents/backtest →
            </Link>
            <span className="text-muted-foreground/40">·</span>
            <Link
              href="/"
              className="text-xs text-sky-400 hover:text-sky-300 underline"
            >
              對照看首頁 →
            </Link>
          </div>
        </div>

      </div>
    </PageShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function Section({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold tracking-wider text-foreground">{title}</h2>
        {caption && <p className="text-xs text-muted-foreground mt-0.5">{caption}</p>}
      </div>
      {children}
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-card border border-border rounded-xl p-4">{children}</div>;
}

function Divider() {
  return <div className="h-px bg-border my-3" />;
}

function Row({ label, code, children }: { label: string; code: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</span>
        <code className="text-[10px] text-sky-400/80 font-mono">{code}</code>
      </div>
      <div className="border border-border/60 rounded-lg bg-muted/20">
        {children}
      </div>
    </div>
  );
}

function CardLabel({ tag, code, inset }: { tag: string; code: string; inset?: boolean }) {
  return (
    <div className={inset ? 'px-4 pt-3 pb-1' : 'mb-3'}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-sky-400 font-semibold">{tag}</span>
        <code className="text-[10px] text-muted-foreground font-mono">{code}</code>
      </div>
    </div>
  );
}

function BannerLabel({ code }: { code: string }) {
  return (
    <code className="text-[10px] text-muted-foreground font-mono block">{code}</code>
  );
}

/**
 * 模擬 PageHeader 在 PageShell h-12 sticky header 內的長相
 * — 不是用真實 PageShell（已包整頁），只在卡內示意位置
 */
function MockHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="h-12 px-3 flex items-center gap-2 text-xs min-w-0">
      <span className="text-muted-foreground hover:text-foreground transition-colors text-lg leading-none cursor-pointer">⬅️</span>
      <span className="font-bold text-sm whitespace-nowrap shrink-0">{title}</span>
      {subtitle && (
        <span className="text-muted-foreground shrink-0 truncate">{subtitle}</span>
      )}
      {actions && (
        <div className="flex items-center gap-1.5 ml-auto shrink-0">{actions}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Before / After 對照
// ─────────────────────────────────────────────────────────────────────────────

/** 模擬目前 /agents/backtest 的 light-theme 寫法 — 注意 dark mode 下文字會看不見 */
function BeforeBacktest() {
  return (
    <div className="space-y-3 p-4 max-w-full mx-auto bg-white text-black rounded-xl border-2 border-rose-500/50">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Backtest 回測</h1>
          <p className="text-sm text-gray-500">128 筆決策 · 14 天區間</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" className="border rounded px-2 py-1 text-sm" defaultValue="2026-05-23" />
          <button className="border rounded px-3 py-1 text-sm bg-blue-50 hover:bg-blue-100">Build</button>
          <button className="border rounded px-3 py-1 text-sm hover:bg-gray-50">重整</button>
          <button className="text-sm text-gray-600">⬅️ 回主頁</button>
        </div>
      </header>
      <div className="border border-blue-300 bg-blue-50 text-blue-900 rounded p-3 text-sm">
        ✅ 已 build 2026-05-23: 32 筆
      </div>
      <section>
        <h2 className="font-semibold text-sm">Final Action 績效</h2>
        <table className="min-w-full text-sm border mt-1">
          <thead className="bg-gray-100">
            <tr>
              <th className="border px-3 py-2 text-left">Action</th>
              <th className="border px-3 py-2 text-center">樣本</th>
              <th className="border px-3 py-2 text-center">avg d5</th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-green-50">
              <td className="border px-3 py-2 font-semibold">BUY</td>
              <td className="border px-3 py-2 text-center font-mono">128</td>
              <td className="border px-3 py-2 text-center font-mono">+3.18%</td>
            </tr>
            <tr className="bg-yellow-50">
              <td className="border px-3 py-2 font-semibold">WATCH</td>
              <td className="border px-3 py-2 text-center font-mono">47</td>
              <td className="border px-3 py-2 text-center font-mono">+1.02%</td>
            </tr>
          </tbody>
        </table>
      </section>
      <div className="border border-dashed border-gray-300 rounded p-3 text-xs text-gray-500">
        使用流程：先跑 Multi-Agent 對某日做決策...
      </div>
      <div className="text-[10px] text-rose-600 font-bold pt-2 border-t border-rose-200">
        ⚠ 整頁強制白底 + gray text；切 dark mode 整段灰字會看不見、blue-50 banner 跟背景融在一起
      </div>
    </div>
  );
}

/** 套上規格後的樣子 — 跟首頁一致 */
function AfterBacktest() {
  return (
    <div className="space-y-3 p-4 max-w-full mx-auto bg-background rounded-xl border-2 border-emerald-500/50">
      {/* 假 PageHeader（真實情況走 PageShell.headerSlot） */}
      <div className="-mx-4 -mt-4 mb-2 border-b border-border px-3 h-12 flex items-center gap-2 text-xs">
        <span className="text-muted-foreground text-lg leading-none">⬅️</span>
        <span className="font-bold text-sm">📊 Backtest 回測</span>
        <span className="text-muted-foreground shrink-0 truncate">128 筆 · 14 天</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="secondary" size="sm">Build</Button>
          <Button variant="ghost" size="sm">重整</Button>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <label className="flex items-center gap-1 text-muted-foreground">
          from
          <input
            type="date"
            defaultValue="2026-05-09"
            className="bg-secondary border border-border rounded px-2 py-1 text-foreground font-mono"
          />
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          to
          <input
            type="date"
            defaultValue="2026-05-23"
            className="bg-secondary border border-border rounded px-2 py-1 text-foreground font-mono"
          />
        </label>
      </div>

      <div className="border border-sky-500/40 bg-sky-500/10 text-sky-300 rounded-lg p-3 text-sm">
        ✅ 已 build 2026-05-23: 32 筆
      </div>

      <section className="bg-card border border-border rounded-xl p-4">
        <h2 className="text-xs font-semibold tracking-wider text-foreground mb-3">▸ Final Action 績效</h2>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground border-b border-border">
            <tr className="text-left">
              <th className="py-2 pr-2">Action</th>
              <th className="py-2 pr-2 text-center">樣本</th>
              <th className="py-2 pr-2 text-right">avg d5</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border/40 hover:bg-muted/30 bg-emerald-900/10">
              <td className="py-2 pr-2 font-semibold text-emerald-300">BUY</td>
              <td className="py-2 pr-2 text-center font-mono">128</td>
              <td className="py-2 pr-2 text-right font-mono text-emerald-400">+3.18%</td>
            </tr>
            <tr className="border-b border-border/40 hover:bg-muted/30 bg-amber-900/10">
              <td className="py-2 pr-2 font-semibold text-amber-300">WATCH</td>
              <td className="py-2 pr-2 text-center font-mono">47</td>
              <td className="py-2 pr-2 text-right font-mono">+1.02%</td>
            </tr>
          </tbody>
        </table>
      </section>

      <div className="border-2 border-dashed border-border rounded-lg p-3 text-xs text-muted-foreground">
        使用流程：先跑 Multi-Agent 對某日做決策...
      </div>

      <div className="text-[10px] text-emerald-400 font-bold pt-2 border-t border-emerald-700/30">
        ✓ 切 dark / light mode 都正常；banner / table thead / button 都用 semantic tokens
      </div>
    </div>
  );
}
