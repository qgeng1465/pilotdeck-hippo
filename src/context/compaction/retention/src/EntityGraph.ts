export type EntityGraphOptions = {
  windowSize?: number;
  /** CJK entities appearing in more than this fraction of messages are pruned as stop-words. */
  cjkMaxDocumentFrequency?: number;
  /** Minimum number of CJK-bearing messages before document-frequency pruning kicks in. */
  cjkMinMessagesForPruning?: number;
};

const STOP_ENTITIES = new Set([
  "assistant", "system", "user", "tool", "true", "false", "null", "status",
  "output", "input", "result", "results", "error", "errors", "message",
  "messages", "completed", "processing", "analysis", "value", "values",
  "index", "name", "type", "data", "file", "files", "path", "task",
  "step", "qc", "ok", "latest", "total", "next", "final", "current",
]);

const CJK_RUN = /[一-鿿]{2,}/g;
// Non-global sibling for .test() — a /g regex carries lastIndex across calls.
const CJK_TEXT = /[一-鿿]/;

function extractAsciiEntities(text: string): string[] {
  // Core-domain entities in this engine are Pascal/Camel/upper-case names
  // (genes, methods, cohort ids, markers). Lower-case prose and disposable
  // tool noise are deliberately excluded so PageRank is not diluted.
  const ascii = text.match(/\b[A-Z][A-Za-z0-9_-]{1,}\b/g) ?? [];
  const entities = new Set<string>();
  for (const token of ascii) {
    const lower = token.toLowerCase();
    if (STOP_ENTITIES.has(lower)) continue;
    if (/^\d/.test(token)) continue;
    entities.add(token);
  }
  return [...entities];
}

function extractCjkEntities(text: string): string[] {
  // Chinese has no whitespace boundaries, so whole sentences would collapse
  // into one unusable token. Overlapping character bigrams act as
  // segmentation-free pseudo-words: recurring content bigrams (gene names,
  // method names, domain terms) reconnect across messages and let PageRank
  // see the same hub structure the ASCII path exploits. Ubiquitous function
  // bigrams are removed later by document-frequency pruning in build().
  const entities = new Set<string>();
  for (const match of text.matchAll(CJK_RUN)) {
    const run = match[0];
    for (let index = 0; index + 2 <= run.length; index += 1) {
      entities.add(run.slice(index, index + 2));
    }
  }
  return [...entities];
}

function extractEntities(text: string): string[] {
  return [...extractAsciiEntities(text), ...extractCjkEntities(text)];
}

export class EntityGraph {
  private readonly adjacency = new Map<string, Map<string, number>>();
  private messageEntities: Array<{ messageIndex: number; entities: string[] }> = [];
  private normalizedRank = new Map<string, number>();
  private entityDocumentFrequency = new Map<string, number>();
  private totalMessageCount = 0;

  build(messages: Array<{ text: string }>, options: EntityGraphOptions = {}): this {
    const windowSize = options.windowSize ?? 5;
    const cjkMaxDocumentFrequency = options.cjkMaxDocumentFrequency ?? 0.5;
    const cjkMinMessagesForPruning = options.cjkMinMessagesForPruning ?? 6;
    const rawEntities = messages.map((message) => extractEntities(message.text));

    // A CJK bigram present in most messages is function prose (的了/一个/数据),
    // not a topic marker. Left in, it becomes a PageRank hub shared by every
    // message and flattens the ranking. Prune bigrams whose document frequency
    // exceeds the threshold, sampled over enough messages to be meaningful.
    // ASCII entities keep their original extraction semantics (uppercase
    // heuristic already excludes prose) and are never pruned here.
    const cjkMessageCount = rawEntities.filter((entities) =>
      entities.some((entity) => CJK_TEXT.test(entity))
    ).length;
    const documentFrequency = new Map<string, number>();
    for (const entities of rawEntities) {
      for (const entity of new Set(entities)) {
        documentFrequency.set(entity, (documentFrequency.get(entity) ?? 0) + 1);
      }
    }
    const pruningActive = cjkMessageCount >= cjkMinMessagesForPruning;
    const maxDocumentFrequency = cjkMessageCount * cjkMaxDocumentFrequency;
    const isPruned = (entity: string) =>
      pruningActive && CJK_TEXT.test(entity)
        ? (documentFrequency.get(entity) ?? 0) > maxDocumentFrequency
        : false;

    this.messageEntities = rawEntities.map((entities, messageIndex) => ({
      messageIndex,
      entities: entities.filter((entity) => !isPruned(entity)),
    }));
    this.entityDocumentFrequency = documentFrequency;
    this.totalMessageCount = messages.length;
    this.adjacency.clear();

    const edges = new Map<string, Map<string, number>>();
    const addEdge = (from: string, to: string) => {
      if (from === to) return;
      const row = edges.get(from) ?? new Map<string, number>();
      row.set(to, (row.get(to) ?? 0) + 1);
      edges.set(from, row);
    };

    for (let i = 0; i < this.messageEntities.length; i += 1) {
      const current = this.messageEntities[i]!.entities;
      for (let j = i + 1; j < Math.min(this.messageEntities.length, i + 1 + windowSize); j += 1) {
        const neighbor = this.messageEntities[j]!.entities;
        for (const from of current) {
          for (const to of neighbor) {
            addEdge(from, to);
          }
        }
      }
    }
    this.adjacency.clear();
    for (const [from, row] of edges) {
      this.adjacency.set(from, new Map(row));
    }
    return this;
  }

  pageRank(options: { iterations?: number; damping?: number } = {}): Map<string, number> {
    const iterations = options.iterations ?? 32;
    const damping = options.damping ?? 0.85;
    const nodes = [...this.adjacency.keys()];
    if (nodes.length === 0) {
      this.normalizedRank = new Map();
      return new Map(this.normalizedRank);
    }

    const teleport = (1 - damping) / nodes.length;
    const rank = new Map(nodes.map((node) => [node, 1 / nodes.length]));
    const outDegrees = new Map(
      nodes.map((node) => [node, Math.max(1, this.adjacency.get(node)?.size ?? 0)]),
    );

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const next = new Map(nodes.map((node) => [node, teleport]));
      for (const from of nodes) {
        const row = this.adjacency.get(from);
        if (!row) continue;
        const contribution = (rank.get(from) ?? 0) / (outDegrees.get(from) ?? 1);
        for (const to of row.keys()) {
          next.set(to, (next.get(to) ?? 0) + damping * contribution);
        }
      }
      for (const node of nodes) {
        rank.set(node, next.get(node) ?? teleport);
      }
    }

    const max = Math.max(...rank.values());
    this.normalizedRank = new Map(
      nodes.map((node) => [node, max > 0 ? (rank.get(node) ?? 0) / max : 0]),
    );
    return new Map(this.normalizedRank);
  }

  /**
   * Per-message entity-centrality score in [0, 1].
   *
   * Raw PageRank rewards co-occurrence hubs, and in tool-call transcripts the
   * hubs are boilerplate (the same tool names, QC words, or paths repeated in
   * every message) while the distinctive facts appear in only one or two
   * messages. Multiplying each entity's normalized rank by its IDF
   * log(1 + M/df) suppresses the boilerplate hubs and lifts the distinctive
   * entities before the per-message max is taken, then the array is
   * re-normalized to [0, 1] so the policy weights keep their meaning.
   */
  messageRankScores(options: { idfCorrection?: boolean } = {}): number[] {
    const idfCorrection = options.idfCorrection ?? true;
    const scores = this.messageEntities.map((entry) => {
      let best = 0;
      for (const entity of entry.entities) {
        const rank = this.normalizedRank.get(entity) ?? 0;
        const weight = idfCorrection
          ? Math.log(1 + this.totalMessageCount / Math.max(1, this.entityDocumentFrequency.get(entity) ?? 1))
          : 1;
        best = Math.max(best, rank * weight);
      }
      return best;
    });
    const max = Math.max(0, ...scores);
    return max > 0 ? scores.map((score) => score / max) : scores;
  }

  rankForMessage(messageIndex: number): number {
    const entry = this.messageEntities[messageIndex];
    if (!entry || entry.entities.length === 0) return 0;
    let best = 0;
    for (const entity of entry.entities) {
      best = Math.max(best, this.normalizedRank.get(entity) ?? 0);
    }
    return best;
  }

  /** Extracted (post-pruning) entities of one message; exposed for tests and UI visualization. */
  entitiesForMessage(messageIndex: number): string[] {
    return [...(this.messageEntities[messageIndex]?.entities ?? [])];
  }
}
