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
 * Default component weights, re-anchored by the benchmarks/tune.ts sweep
 * (2026-09-11, EN+ZH x 3 seeds, N=80): similarity against the pending user
 * request is the dominant fact-recovery signal; recency and IDF-corrected
 * PageRank stay as small complementary terms. The old 0.4/0.35/0.25 mix
 * let time and rank dilute the similarity term and collapsed when no
 * query hint existed.
 */
export const EBBINGHAUS_DEFAULT_WEIGHTS = {
  wSim: 0.7,
  wTime: 0.15,
  wRank: 0.15,
} as const;

export class EbbinghausPageRankPolicy implements RetentionScorePolicy {
  readonly id = "ebbinghaus-pagerank";

  constructor(private readonly options: EbbinghausPolicyOptions = {}) {}

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
