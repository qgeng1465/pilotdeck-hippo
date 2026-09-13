import type { HippoMessage } from "./HippoMessage.js";

/**
 * The single additive hook the compaction engine offers.
 *
 * Parameterised by the caller's own message type, which defaults to this
 * package's `HippoMessage`. A host that has a richer message type writes
 * `RetentionScorePolicy<ItsMessage>` and gets that same type back out of
 * `pickRetained`, so `messagesToKeep` keeps whatever type it always had
 * without this package knowing that type by name.
 *
 * The parameter is on the *type*, not on the two methods, and that is
 * deliberate. Generic methods would make the interface unimplementable by
 * ordinary code: a class or object literal with a concrete
 * `scoreMessages(input: { candidates: CanonicalMessage[] })` cannot satisfy
 * `<I extends HippoMessage>(input: { candidates: I[] }) => …`, so every spy,
 * recording wrapper and test double in the host would have to be written
 * generically (and cast internally) just to type-check.
 */
export type RetentionScorePolicy<M extends HippoMessage = HippoMessage> = {
  id: string;
  /**
   * Optional self-description of the effective term weights. Surfaced in
   * `CompactionResult.retention` so operators, logs and the UI can report
   * which policy produced a given retention outcome without having to read
   * the config back.
   */
  readonly weights?: { wSim: number; wTime: number; wRank: number };
  scoreMessages(input: {
    candidates: M[];
    queryHint?: string;
  }): Promise<Map<M, number>>;
  pickRetained(input: {
    candidates: M[];
    retentionBudgetTokens: number;
    queryHint?: string;
    estimateTokens: (candidates: M[]) => number;
  }): Promise<M[]>;
};

export type EbbinghausPolicyOptions = {
  /** True Transformer.js embedding instance; omitting it selects the BM25 fallback. */
  embedding?: import("./LocalEmbedding.js").LocalEmbedding | null;
  wSim?: number;
  wTime?: number;
  wRank?: number;
  lambda?: number;
  /** Length of the conversation-time window used for Ebbinghaus decay, in normalized units. */
  tau?: number;
  pageRankIterations?: number;
  pageRankDamping?: number;
  entityWindowSize?: number;
  /** Multiply PageRank by entity IDF before per-message max; set false for raw centrality. */
  idfCorrection?: boolean;
  /**
   * Fraction of the retention token budget that messages kept verbatim by a
   * previous compaction may claim ahead of the score-ordered fill. Default
   * `CARRYOVER_BUDGET_SHARE`; 0 disables the allowance without the global
   * `PILOTDECK_CARRYOVER` switch.
   */
  carryOverBudgetShare?: number;
};
