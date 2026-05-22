/**
 * Bull / Bear Researcher question builder
 *
 * 紅線（§0）：
 *   - Bull/Bear 只引用 A-E answers 已有的 dataPoint，不可自創新事實
 *   - Bear 必須讀 bull-answer 並一對一反駁（contract 守 rebuttals.length === bullThesis.length）
 *   - 兩者都是「辯護角色」，不負責改寫規則
 */

import {
  readBullThesis,
  readChipAnswer,
  readFundamentalAnswer,
  readNewsAnswer,
  readRiskAnswer,
  readTechnicalAnswer,
} from '@/lib/agents/orchestrator';
import {
  AGENT_SCHEMA_VERSION,
  DebateQuestion,
} from '@/lib/agents/types';
import type { MarketId } from '@/lib/scanner/types';

export interface BuildDebateQuestionArgs {
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  /** 'bull' 或 'bear'；bear 會自動讀 bull-answer */
  side: 'bull' | 'bear';
}

export async function buildDebateQuestion(args: BuildDebateQuestionArgs): Promise<DebateQuestion> {
  const { runId, date, symbol, market, side } = args;

  // 讀 A-E 5 個 answer（並行）
  const [tech, news, chip, fundamental, risk] = await Promise.all([
    readTechnicalAnswer(date, symbol),
    readNewsAnswer(date, symbol),
    readChipAnswer(date, symbol),
    readFundamentalAnswer(date, symbol),
    readRiskAnswer(date, symbol),
  ]);

  const question: DebateQuestion = {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: side,
    runId,
    date,
    symbol,
    market,
    analystAnswers: {
      technical: tech,
      news,
      chip,
      fundamental,
      risk,
    },
  };

  // Bear 強制讀 bull-answer
  if (side === 'bear') {
    const bull = await readBullThesis(date, symbol);
    if (bull) question.bullAnswer = bull;
  }

  return question;
}
