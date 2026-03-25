import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import { DEFAULT_RULES } from './defaultRules';

/**
 * Rule Engine — evaluates all registered rules at the current replay index.
 *
 * Design:
 * - Rules are pluggable: any object implementing TradingRule can be added
 * - Rules are evaluated independently (no rule depends on another)
 * - Multiple signals can fire on the same candle
 *
 * To extend:
 * - Add new rules to DEFAULT_RULES array
 * - Or call engine.addRule() at runtime
 * - Future: load rules from JSON config file
 */
export class RuleEngine {
  private rules: TradingRule[];

  constructor(rules: TradingRule[] = DEFAULT_RULES) {
    this.rules = [...rules];
  }

  addRule(rule: TradingRule): void {
    this.rules.push(rule);
  }

  removeRule(ruleId: string): void {
    this.rules = this.rules.filter((r) => r.id !== ruleId);
  }

  getRules(): TradingRule[] {
    return [...this.rules];
  }

  /**
   * Evaluate all rules at the given index.
   * @param candles - Full array with indicators
   * @param index - Current replay position (last visible candle)
   * @returns Array of triggered signals
   */
  evaluate(
    candles: CandleWithIndicators[],
    index: number
  ): RuleSignal[] {
    if (index < 0 || index >= candles.length) return [];

    const signals: RuleSignal[] = [];
    for (const rule of this.rules) {
      try {
        const signal = rule.evaluate(candles, index);
        if (signal) signals.push(signal);
      } catch (err) {
        // Isolate rule errors so one broken rule doesn't crash everything
        console.warn(`Rule "${rule.id}" threw an error:`, err);
      }
    }
    return signals;
  }
}

// Singleton instance — shared across the app
export const ruleEngine = new RuleEngine();
