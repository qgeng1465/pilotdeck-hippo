import type { HippoMessage } from "./HippoMessage.js";

/**
 * Carry-over priority for messages the policy already kept verbatim.
 *
 * Retention is planned from scratch on every compaction: the candidates are the
 * messages in the summarize bucket, scored against the query hint that is
 * current *now*. A message compaction #1 deliberately preserved therefore gets
 * no credit on compaction #2 -- it re-enters the bucket, is scored against a
 * hint that drifts with the task, and can silently fall out of the verbatim
 * block, leaving only a summary line (or nothing) behind. On one task that spans
 * several compactions the verbatim block churns instead of accumulating, and the
 * facts that had the longest to travel are the ones that go first
 * (`benchmarks/longHorizon.ts` measures exactly this: pre-carry-over, Hippo's
 * foundation facts decayed from 5/5 to 1/5 over three rounds, i.e. to upstream's
 * number). Carry-over does not reverse that decay; it slows the churn one
 * bracket in. See "What it actually buys" below before quoting any number.
 *
 * ## Why a reserved sub-budget rather than a score bonus
 *
 * The obvious fix -- add a constant to the carried message's score -- was
 * implemented, measured and rejected. It holds the foundation, but a flat bonus
 * large enough to keep an old message in the block is also large enough to
 * outrank the message the *pending request is actually about*, and on the
 * long-horizon harness that collapsed the recent bracket from 5/5 to 1.67/5 by
 * round 3. Trading one bracket for another is not a fix.
 *
 * Instead, carried messages get a bounded allowance of their own:
 *
 *   - Candidates are still ranked by their own score, unaffected.
 *   - Carried messages may take at most `CARRYOVER_BUDGET_SHARE` of the
 *     retention token budget, highest-scoring carried message first.
 *   - Everything left is filled in plain score order, exactly as before, so
 *     current-query relevance keeps the rest of the budget and never has to
 *     out-rank a bonus it cannot see.
 *
 * The allowance is a *cap on spend*, not a reordering, so carry-over can never
 * outrank relevance: at worst it occupies a bounded fraction of the block, and
 * the retention budget (`max(256, 0.2 * tailTokenBudget)`) stays exactly as hard
 * as it was -- carried tokens are charged against it like any other candidate.
 *
 * ## What it actually buys (measured, do not overclaim)
 *
 * `benchmarks/longHorizon.ts`, 80 seeds, final bracket, facts out of 5:
 *
 *   carry-over off ............ foundation 1.01  mid 1.36  recent 5.00
 *   carry-over on (this code) . foundation 1.00  mid 1.80  recent 4.97
 *
 * So: the middle bracket is what improves; the *oldest* bracket does not move.
 * That is mechanistic, not noise -- the allowance is filled best-current-score
 * first, and the oldest carried messages are exactly the ones with the weakest
 * similarity and recency, so they lose the allowance to carried messages from
 * the previous round. Filling it oldest-first instead does reach the oldest
 * bracket (foundation 2.01) but pays for it with the two newer ones
 * (mid 0.45, recent 4.80), i.e. it trades brackets and loses on total; that
 * variant was measured and not taken. Read this code as "keeps carried messages
 * from silently churning", not as "rescues the oldest facts".
 *
 * `PILOTDECK_CARRYOVER=off|0|false|no|disabled` disables the whole mechanism so
 * the before/after is reproducible without checking out older code; the default
 * is on.
 */
export const CARRYOVER_BUDGET_SHARE = 0.25;

const DISABLED_VALUES = new Set(["off", "0", "false", "no", "disabled"]);

/** Whether carry-over priority is enabled for this process. Default: on. */
export function isCarryOverEnabled(): boolean {
  const raw = process.env.PILOTDECK_CARRYOVER;
  if (raw === undefined) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/** True when a previous compaction kept this message verbatim. */
export function isHippoRetained(message: HippoMessage): boolean {
  return message.metadata?.hippoRetained === true;
}

/**
 * Copy of `message` marked as retained by the score policy. Copying (rather
 * than mutating) keeps the caller's message objects untouched and keeps the
 * engine's identity-based reporting working: the copy is what lands in
 * `messagesToKeep`, so the same object is still the one compared to report
 * which messages the policy contributed.
 *
 * Generic so the copy keeps the caller's message type; the spread is exactly
 * `I` with one metadata field overridden, which is what the single cast
 * asserts.
 */
export function withHippoRetainedMarker<I extends HippoMessage>(message: I): I {
  return { ...message, metadata: { ...message.metadata, hippoRetained: true } } as I;
}
