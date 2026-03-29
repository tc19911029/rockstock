/**
 * Multi-role AI analysis — shared types.
 * ROLE-01 through ROLE-10.
 */

/** Individual role analysis result */
export interface RoleAnalysis {
  role: string;
  title: string;      // Chinese display name, e.g. "技術面分析師"
  verdict: 'bullish' | 'bearish' | 'neutral';
  confidence: number;  // 0-100
  summary: string;     // 2-3 sentence Chinese summary
  keyPoints: string[]; // 3-5 bullet points
  rawContent: string;  // Full analysis text
}

/** Bull/Bear debate result */
export interface DebateAnalysis extends RoleAnalysis {
  referencedRoles: string[];  // Which analyst roles this position references (ROLE-03)
}

/** Research director synthesis */
export interface SynthesisResult {
  role: 'research-director';
  title: string;
  overallVerdict: 'strong-buy' | 'buy' | 'hold' | 'sell' | 'strong-sell';
  confidence: number;
  summary: string;
  recommendation: string;
  riskFactors: string[];
  keyPoints: string[];
  rawContent: string;
}

/** Complete analysis result for a ticker */
export interface FullAnalysisResult {
  ticker: string;
  companyName: string;
  analysisDate: string;
  analysts: RoleAnalysis[];      // Technical, Fundamental, News
  debate: DebateAnalysis[];      // Bull, Bear
  synthesis: SynthesisResult;
  totalDurationMs: number;
}

/** Progress callback for streaming UI updates */
export type ProgressCallback = (
  phase: 'analysts' | 'debate' | 'synthesis',
  currentRole: string,
  completed: number,
  total: number
) => void;
