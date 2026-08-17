/**
 * Decision Agent question builder
 *
 * 紅線（§0）：
 *   - 規則式整合表，**不是加權平均**
 *   - 不允許 LLM 產生「總分」這種混合概念
 *   - Technical fail → action='skip'（最高優先，無例外）
 *   - Risk red → action='skip'
 *   - 各面向 verdict 並列展示（verdictsByAgent）
 *
 * decisionRulesRef 直接寫死成 prompt 中的字串供 LLM 對照（不可改寫）
 */

import {
  readBearThesis,
  readBullThesis,
  readChipAnswer,
  readFundamentalAnswer,
  readNewsAnswer,
  readRiskAnswer,
  readTechnicalAnswer,
} from '@/lib/agents/orchestrator';
import {
  AGENT_SCHEMA_VERSION,
  DecisionQuestion,
} from '@/lib/agents/types';
import type { MarketId } from '@/lib/scanner/types';

/**
 * 規則式決策表 — Decision Agent 必須嚴格遵守，違反就 contract reject
 *
 * 命中規則的順序（從上到下）：第一條符合就取那條 decisionPath
 */
export const DECISION_RULES_REF = `
規則式決策表（嚴格守，違反 reject）

│ 條件                                          │ action │ decisionPath          │
│ Technical verdict='fail'                      │ skip   │ technical_fail        │
│ Technical=pass + Risk=red                     │ skip   │ risk_red              │
│ Technical=pass + Risk=green + Bull-Bear ≥ 2  │ buy    │ buy_signal            │
│ Technical=pass + Risk=yellow                  │ watch  │ risk_yellow_watch     │
│ Technical=pass + |Bull-Bear| < 2              │ watch  │ debate_neutral_watch  │
│ Technical=watch（其他面向任意）                │ watch  │ technical_watch       │
│ 其他                                           │ watch  │ default_watch         │

注意：
1. **不允許**用「總分」「綜合評等」「加權平均」決定 action
2. **不允許**因為消息面/籌碼/基本面好而把 Technical fail 升級為 watch
3. 衝突時必須在 conflicts[] 明寫，不可隱藏
4. entryPrice 從 Technical Agent dataPoints 取（price 欄位）
5. stopLoss 從 Risk Agent suggestedStopLoss 取（沒有就 undefined）
`.trim();

export interface BuildDecisionQuestionArgs {
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
}

export async function buildDecisionQuestion(args: BuildDecisionQuestionArgs): Promise<DecisionQuestion> {
  const { runId, date, symbol, market } = args;

  const [tech, news, chip, fundamental, risk, bull, bear] = await Promise.all([
    readTechnicalAnswer(date, symbol, runId),
    readNewsAnswer(date, symbol, runId),
    readChipAnswer(date, symbol, runId),
    readFundamentalAnswer(date, symbol, runId),
    readRiskAnswer(date, symbol, runId),
    readBullThesis(date, symbol, runId),
    readBearThesis(date, symbol, runId),
  ]);

  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'decision',
    runId,
    date,
    symbol,
    market,
    inputs: { technical: tech, news, chip, fundamental, risk, bull, bear },
    decisionRulesRef: DECISION_RULES_REF,
  };
}
