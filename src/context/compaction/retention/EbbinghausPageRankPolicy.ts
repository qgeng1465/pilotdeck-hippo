import type { CanonicalMessage } from "../../../model/index.js";
import { EntityGraph } from "./EntityGraph.js";
import { bm25Relevance, ebbinghausScore } from "./EbbinghausScore.js";
import { tryLoadTransformersEmbedding } from "./LocalEmbedding.js";
import { messageVisibleText } from "./MessageText.js";
import type { EbbinghausPolicyOptions, RetentionScorePolicy } from "./RetentionTypes.js";

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i]! * right[i]!;
    leftNorm += left[i]! * left[i]!;
    rightNorm += right[i]! * right[i]!;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/**
 * Default component weights.
 *
 * These are the argmax of `benchmarks/tune.ts` (18-config grid over
 * seeds 20260911..20260913, EN+ZH, N=80), which is what they should be:
 *
 *   S0.85/T0.15/R0 .. 72/120   <- this
 *   S0.85/T0.15/R0.15 70/120
 *   S0.7/T0.15/R0.15 .. 68/120 (the value shipped before this change)
 *
 * Note where the ranking actually comes from: EN is saturated (45/60 for most
 * of the top configs, so EN does not separate them), and the ordering is
 * driven by ZH (27 vs 23). Treat a 4-point ZH gap on 3 seeds as a tie-breaker,
 * not a result.
 *
 * Because the tuning seeds are by definition *seen*, `benchmarks/holdout.ts`
 * re-tests this choice on seeds 20260921..20260930, which nothing selected on.
 * There it holds up: 0.85/0.15/0 is >= the previous 0.7/0.15/0.15 in all four
 * (language x size) cells — 9.4/17.9/6.0/10.0 vs 9.3/17.7/6.0/9.5 — and across
 * 40 per-seed pairings the PageRank term contributed 0 wins, 33 ties, 3 losses.
 *
 * The PageRank term is therefore no longer weighted by default, but it is kept
 * in the policy: it is the only query-independent signal available, and the
 * no-query probe in tune.ts shows it is the least-bad term when there is no
 * pending request to score against — a regime where every variant sits near
 * the floor (<=3/20). `idfCorrection` still applies whenever the term is used.
 *
 * Anyone re-tuning: change the numbers only with a `benchmark:tune` run *and*
 * a `benchmark:holdout` run, in that order.
 */
export const EBBINGHAUS_DEFAULT_WEIGHTS = {
  wSim: 0.85,
  wTime: 0.15,
  wRank: 0,
} as const;

export class EbbinghausPageRankPolicy implements RetentionScorePolicy {
  readonly id = "ebbinghaus-pagerank";

  constructor(private readonly options: EbbinghausPolicyOptions = {}) {}

  /** Effective (normalized) weights actually used when scoring. */
  get weights(): { wSim: number; wTime: number; wRank: number } {
    const raw = {
      wSim: this.options.wSim ?? EBBINGHAUS_DEFAULT_WEIGHTS.wSim,
      wTime: this.options.wTime ?? EBBINGHAUS_DEFAULT_WEIGHTS.wTime,
      wRank: this.options.wRank ?? EBBINGHAUS_DEFAULT_WEIGHTS.wRank,
    };
    const total = Math.max(1, raw.wSim + raw.wTime + raw.wRank);
    return { wSim: raw.wSim / total, wTime: raw.wTime / total, wRank: raw.wRank / total };
  }

  async scoreMessages(input: {
    candidates: CanonicalMessage[];
    queryHint?: string;
  }): Promise<Map<CanonicalMessage, number>> {
    const scores = await this.score(input.candidates, input.queryHint);
    return new Map(scores.map(({ message, score }) => [message, score]));
  }

  async pickRetained(input: {
    candidates: CanonicalMessage[];
    retentionBudgetTokens: number;
    queryHint?: string;
    estimateTokens: (candidates: CanonicalMessage[]) => number;
  }): Promise<CanonicalMessage[]> {
    if (input.candidates.length === 0 || input.retentionBudgetTokens <= 0) return [];
    const scored = await this.score(input.candidates, input.queryHint);
    scored.sort((left, right) => right.score - left.score);

    const retained: CanonicalMessage[] = [];
    let usedTokens = 0;
    for (const entry of scored) {
      const tokens = input.estimateTokens([entry.message]);
      if (tokens <= 0) continue;
      if (usedTokens + tokens > input.retentionBudgetTokens) continue;
      retained.push(entry.message);
      usedTokens += tokens;
    }
    return retained;
  }

  private async score(
    candidates: CanonicalMessage[],
    queryHint: string | undefined,
  ): Promise<Array<{ message: CanonicalMessage; score: number }>> {
    const candidateTexts = candidates.map(messageVisibleText);
    const textsWithIndices = candidateTexts.map((text, index) => ({ text, index }));
    const queryText = queryHint?.trim() || "";
    const weights = {
      wSim: this.options.wSim ?? EBBINGHAUS_DEFAULT_WEIGHTS.wSim,
      wTime: this.options.wTime ?? EBBINGHAUS_DEFAULT_WEIGHTS.wTime,
      wRank: this.options.wRank ?? EBBINGHAUS_DEFAULT_WEIGHTS.wRank,
    };
    const weightTotal = weights.wSim + weights.wTime + weights.wRank;
    const normalizedWeights = {
      wSim: weights.wSim / Math.max(1, weightTotal),
      wTime: weights.wTime / Math.max(1, weightTotal),
      wRank: weights.wRank / Math.max(1, weightTotal),
    };

    let embedding = this.options.embedding;
    if (embedding === undefined) {
      embedding = await tryLoadTransformersEmbedding();
    }

    let semanticScores: number[];
    if (embedding && queryText) {
      const vectors = await embedding.embedMany([queryText, ...candidateTexts]);
      const queryVector = vectors[0] ?? [];
      semanticScores = candidateTexts.map((_, index) => cosineSimilarity(queryVector, vectors[index + 1] ?? []));
    } else {
      semanticScores = queryText ? bm25Relevance(queryText, candidateTexts) : candidateTexts.map(() => 0.5);
    }

    const lambda = this.options.lambda ?? 1;
    const recencyScores = textsWithIndices.map((_, index) => {
      const count = textsWithIndices.length;
      if (count <= 1) return 1;
      const age = (count - 1 - index) / Math.max(1, count - 1);
      return Math.exp(-lambda * age);
    });

    const graph = new EntityGraph().build(textsWithIndices, {
      windowSize: this.options.entityWindowSize ?? 5,
    });
    graph.pageRank({
      iterations: this.options.pageRankIterations ?? 32,
      damping: this.options.pageRankDamping ?? 0.85,
    });
    const coreScores = graph.messageRankScores({ idfCorrection: this.options.idfCorrection ?? true });

    const scores = ebbinghausScore({
      candidates: textsWithIndices,
      queryText,
      recencyScores,
      coreScores,
      semanticScores,
      weights: normalizedWeights,
    });

    return candidates.map((message, index) => ({ message, score: scores[index] ?? 0 }));
  }
}

export function buildEbbinghausPageRankPolicy(
  options: EbbinghausPolicyOptions = {},
): EbbinghausPageRankPolicy {
  return new EbbinghausPageRankPolicy(options);
}

/**
 * Resolve the app-level retention switch (`agent.compaction.retention` in
 * ~/.pilotdeck/pilotdeck.yaml). This fork defaults to the Hippo policy;
 * `off` restores plain upstream compaction. The engine-level API stays
 * opt-in — constructing a CompactionEngine without `scorePolicy` keeps
 * upstream behavior byte-for-byte, which `benchmark:no-regression` guards.
 */
export function resolveRetentionScorePolicy(
  compaction: { retention?: "hippo" | "off" } | undefined,
): RetentionScorePolicy | undefined {
  return (compaction?.retention ?? "hippo") === "off"
    ? undefined
    : buildEbbinghausPageRankPolicy();
}
