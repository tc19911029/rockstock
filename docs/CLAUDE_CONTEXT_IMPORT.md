# Claude context import for rockstock

## Purpose

This document preserves the useful project context recovered from TC's Claude data export without storing raw conversations or account data. It is a migration aid, not a product specification or a source of current technical truth.

Source reviewed: Claude data export containing 63 conversations, Claude memory, three Claude Projects, and one design chat. Review performed on 2026-08-04. The original export remains outside this repository.

## User and working preferences

- Primary language: Traditional Chinese.
- Preferred style: concise, direct, practical, and outcome-oriented.
- For authorized work, TC prefers autonomous execution instead of repeated confirmation prompts (historically expressed as「不要等我確認，直接做」).
- Analysis should distinguish confirmed numerical or code defects from formula hygiene, presentation concerns, uncertain hypotheses, and known data limitations.
- Deliverables are most useful when consolidated and actionable, with exact file paths, concrete changes, and verification results.
- When improving an existing spreadsheet, UI, or workflow, preserve its original structure where practical.

These preferences never override safety boundaries, repository instructions, or the need to ask when a decision would materially change scope.

## Historical project trajectory

### Stock replay and early code review

The predecessor project was described as `stock-replay`, a React/Next.js/TypeScript candlestick replay and stock-strategy practice application. Historical Claude reviews reported issues involving replay start position, sell-signal filtering, Taiwan brokerage minimum fees, fee-aware position sizing, inconsistent thresholds, and duplicated trading logic.

Those findings are historical. File layout and implementation have changed substantially, so none should be treated as an open defect without reproducing it in the current repository.

### Backtest integrity lessons

Earlier reviews emphasized several recurring research risks:

- ambiguous same-candle stop-loss/take-profit ordering;
- missing slippage and gap execution models;
- incorrect peak-to-trough maximum drawdown calculations;
- survivorship bias and silently skipped data;
- inconsistent return baselines;
- missing capital and position-sizing constraints;
- unadjusted price data;
- lack of walk-forward or out-of-sample validation;
- overfitting caused by repeated strategy search on small samples.

These lessons align with the current repository's stronger “honest edge” discipline. Current contracts, requirements, and implementation always take precedence.

### Autonomous research loop

Claude previously helped frame an autonomous research cycle:

`RESEARCH → BUILD → TEST → DIAGNOSE → EVOLVE`

Early target metrics included win rate, profit/loss ratio, annualized return, drawdown, and minimum trade count. Later experiments showed why target chasing can be misleading: stricter filters often reduced sample size without improving genuine predictive power, and apparently strong variants were vulnerable to beta, costs, selection bias, and overfitting.

The current repository's documented conclusion is more conservative: the product's durable value is risk control, avoidance, disciplined execution, and transparent research rather than promises of stable alpha. Do not restore old targets or “winning” strategy variants merely because they appeared in the export.

### Markets and data sources

The historical scope covered Taiwan stocks and China A-shares. FinMind was preferred for Taiwan data and AKShare was considered for A-shares, with a “download once, read locally” workflow to reduce rate limits and non-determinism. Earlier versions also used Yahoo Finance and documented its data gaps.

Provider choice is now governed by the current repository architecture and fundamental requirements. Historical provider preferences are context only.

## Historical strategy experiments

The export references experiments around six-condition selection, moving-average crosses, volume confirmation, MACD, KD, Bollinger position, RSI reversal, breakout entries, fixed stops, trailing stops, and different holding periods. Some old logs reported attractive headline metrics on small samples.

Do not interpret those results as validated alpha. Before promoting any strategy or ranking factor, require the repository's current cost model, beta adjustment, sample-size checks, train/test consistency, and contract-defined validation path.

## Stable principles worth retaining

1. Prevent future leakage: generate signals only from information available at the decision time and model execution on a realistically tradable bar.
2. Model total trading friction, including commissions, taxes, minimum fees, slippage, gaps, and market-specific constraints.
3. Keep production selection, UI filtering, and backtest logic aligned through shared sources of truth and contract tests.
4. Report sample size, missing-data behavior, universe construction, benchmark-relative performance, and drawdown—not only win rate or raw return.
5. Prefer reproducible local datasets for iterative research, while preserving provenance and freshness metadata.
6. Treat strategy discovery and production promotion as separate stages.
7. Preserve failed experiments and negative findings; they are useful safeguards against repeating unproductive searches.

## Privacy and provenance

- No raw conversation messages were copied into this repository.
- No email address, phone number, account UUID, credentials, private document details, or unrelated personal history was imported.
- Claude-generated summaries can contain errors or outdated claims. Validate important claims using current code, tests, primary data, and current documentation.
- The original export should remain outside version control and should not be committed.
