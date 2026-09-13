function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = normalized.match(/[a-z0-9_]+|[\u4e00-\u9fff]/g) ?? [];
  return tokens;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

/** Deterministic BM25 lexical relevance used when a neural embedding is absent. */
export function bm25Relevance(queryText: string, documentTexts: string[]): number[] {
  if (!queryText.trim() || documentTexts.length === 0) {
    return documentTexts.map(() => 0);
  }
  const queryTokens = [...new Set(tokenize(queryText))];
  if (queryTokens.length === 0) return documentTexts.map(() => 0);

  const docs = documentTexts.map((text) => termFrequency(tokenize(text)));
  const documentFrequencies = new Map<string, number>();
  for (const doc of docs) {
    for (const token of doc.keys()) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }
  }
  const averageLength = Math.max(1, docs.reduce((sum, doc) => {
    let length = 0;
    for (const count of doc.values()) length += count;
    return sum + length;
  }, 0) / docs.length);

  const k1 = 1.5;
  const b = 0.75;
  return docs.map((doc) => {
    let length = 0;
    for (const count of doc.values()) length += count;
    let score = 0;
    for (const queryToken of queryTokens) {
      const tf = doc.get(queryToken) ?? 0;
      if (tf === 0) continue;
      const n = documentFrequencies.get(queryToken) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      const denominator = tf + k1 * (1 - b + (b * length) / averageLength);
      score += idf * (tf * (k1 + 1)) / Math.max(1, denominator);
    }
    return score / (1 + score);
  });
}

export type EbbinghausScoreInput = {
  candidates: Array<{ text: string; index: number }>;
  queryText: string;
  recencyScores: number[];
  coreScores: number[];
  semanticScores: number[];
  weights: { wSim: number; wTime: number; wRank: number };
};

export function ebbinghausScore(input: EbbinghausScoreInput): number[] {
  const { weights } = input;
  return input.candidates.map((_, index) => {
    const semantic = input.semanticScores[index] ?? 0.5;
    const recency = input.recencyScores[index] ?? 0;
    const coreness = input.coreScores[index] ?? 0;
    return Math.max(
      0,
      Math.min(1, weights.wSim * semantic + weights.wTime * recency + weights.wRank * coreness),
    );
  });
}
