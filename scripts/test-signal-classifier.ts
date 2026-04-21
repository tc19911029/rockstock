/**
 * 快速驗證 classifySignal 對常見 label 的分類
 */

import { classifySignal } from '../lib/rules/signalClassifier';
import type { RuleSignal } from '../types';

function mk(type: RuleSignal['type'], label: string, ruleId = 'test-rule', desc = ''): RuleSignal {
  return { type, label, description: desc, reason: '', ruleId };
}

const cases: Array<{ sig: RuleSignal; expect: string; note: string }> = [
  // 3661 畫面上出現的訊號
  { sig: mk('BUY', '上升期（多頭）', 'trend-uptrend'), expect: 'trend', note: '上升期應該是 trend 不是 entry' },
  { sig: mk('SELL', '破MA5出場', 'ma5-exit'), expect: 'exit_strong', note: '破MA5是硬出場' },
  { sig: mk('SELL', '智慧K線賣出', 'smart-kline-sell'), expect: 'exit_soft', note: '智慧K線賣出是情境' },
  { sig: mk('SELL', '上缺回補反轉', 'gap-reversal'), expect: 'exit_soft', note: '缺口回補反轉是情境' },

  // 真進場訊號
  { sig: mk('BUY', '回後買上漲', 'pullback-buy'), expect: 'entry_strong', note: '回後買上漲是書本硬進場' },
  { sig: mk('BUY', '盤整突破', 'range-breakout'), expect: 'entry_strong', note: '盤整突破' },
  { sig: mk('BUY', '假跌破反彈', 'false-break'), expect: 'entry_strong', note: '假跌破反彈' },
  { sig: mk('BUY', '攻擊買進', 'attack'), expect: 'entry_strong', note: '攻擊買進' },

  // 硬出場
  { sig: mk('SELL', '跌破前低', 'break-prev-low'), expect: 'exit_strong', note: '跌破前低硬規則' },
  { sig: mk('SELL', '長黑K吞噬', 'bearish-engulfing'), expect: 'exit_strong', note: '長黑K吞噬' },

  // 警示類
  { sig: mk('WATCH', '乖離警示', 'warn-deviation'), expect: 'warn', note: 'WATCH 型一律 warn' },
  { sig: mk('BUY', '追高警示', 'warn-chase'), expect: 'warn', note: '追高警示 label 命中 warn' },

  // 多頭趨勢
  { sig: mk('BUY', '多頭持續', 'trend-continue'), expect: 'trend', note: '多頭持續' },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = classifySignal(c.sig);
  const ok = got === c.expect;
  if (ok) {
    pass++;
    console.log(`  ✅ "${c.sig.label}" → ${got}`);
  } else {
    fail++;
    console.log(`  ❌ "${c.sig.label}" → got=${got} expect=${c.expect} | ${c.note}`);
  }
}
console.log(`\n結果: ${pass}/${cases.length} pass`);
if (fail > 0) process.exit(1);
