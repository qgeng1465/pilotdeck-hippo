import type { CanonicalMessage } from "../../../model/index.js";

export type RetentionScorePolicy = {
  id: string;
  /**
   * Optional self-description of the effective term weights. Surfaced in
   * `CompactionResult.retention` so operators, logs and the UI can report
   * which policy produced a given retention outcome without having to read
   * the config back.
   */
  readonly weights?: { wSim: number; wTime: number; wRank: number };
  scoreMessages(input: {
    candidates: CanonicalMessage[];
    queryHint?: string;
  }): Promise<Map<CanonicalMessage, number>>;
  pickRetained(input: {
    candidates: CanonicalMessage[];
    retentionBudgetTokens: number;
    queryHint?: string;
    estimateTokens: (candidates: CanonicalMessage[]) => number;
  }): Promise<CanonicalMessage[]>;
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
};
