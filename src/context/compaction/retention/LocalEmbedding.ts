export type LocalEmbedding = {
  readonly kind: "transformers" | "lexical";
  embedMany(texts: string[]): Promise<number[][]>;
};

const VECTOR_DIM = 512;
const STOPWORD_BLOCKLIST = new Set([
  "the", "and", "for", "with", "from", "this", "that", "are", "was", "were",
  "has", "have", "had", "not", "but", "you", "your", "its", "all", "can",
  "will", "into", "over", "under", "then", "than", "also", "each",
]);

function hashIndex(text: string, mod: number): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % mod;
}

function tokens(text: string): string[] {
  const normalized = text.toLowerCase();
  const out: string[] = [];
  const ascii = normalized.match(/[a-z][a-z0-9_]{1,}/g) ?? [];
  for (const word of ascii) {
    if (!STOPWORD_BLOCKLIST.has(word)) out.push(word);
  }
  const numbers = normalized.match(/\d+(?:\.\d+)?/g) ?? [];
  out.push(...numbers);
  for (const char of normalized) {
    if (/[\u4e00-\u9fff]/.test(char)) out.push(char);
  }
  return out;
}

function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) return vector;
  return vector.map((value) => value / norm);
}

/**
 * Offline lexical embedding fallback. It is deterministic and dependency-free;
 * it exists so Hippo still runs when the Transformer.js model is not present.
 */
export class LexicalEmbedding implements LocalEmbedding {
  readonly kind = "lexical" as const;

  async embedMany(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(VECTOR_DIM).fill(0);
      for (const token of tokens(text)) {
        const index = hashIndex(token, VECTOR_DIM);
        vector[index] = Math.log1p(vector[index] + 1);
      }
      return l2Normalize(vector);
    });
  }
}

export function defaultEmbeddingModelPath(): string {
  return process.env.PILOTDECK_BGE_MODEL ?? "";
}

// Loading the local embedding model can hit the network (model download) or a
// cold disk. Bound the wait so a stalled load falls back to BM25 instead of
// blocking a live compaction, and memoize per model path so concurrent
// sessions (and repeated compactions) share one pipeline instead of each
// reloading hundreds of megabytes.
const EMBEDDING_LOAD_TIMEOUT_MS = 15_000;
const embeddingLoadCache = new Map<string, Promise<LocalEmbedding | null>>();

/** Test hook: memoized load promises keyed by model path. */
export const embeddingLoadCacheForTests = embeddingLoadCache;

export async function tryLoadTransformersEmbedding(): Promise<LocalEmbedding | null> {
  const modelPath = defaultEmbeddingModelPath();
  if (!modelPath) return null;
  let load = embeddingLoadCache.get(modelPath);
  if (!load) {
    load = loadTransformersEmbedding(modelPath);
    load.catch(() => {}); // late readers race a timer; never surface unhandled rejections
    embeddingLoadCache.set(modelPath, load);
  }
  const timeout = new Promise<null>((resolveTimeout) => {
    const timer = setTimeout(() => resolveTimeout(null), EMBEDDING_LOAD_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([load, timeout]);
}

async function loadTransformersEmbedding(modelPath: string): Promise<LocalEmbedding | null> {
  const specifier = "@huggingface/transformers";
  let module: Record<string, unknown>;
  try {
    module = await new Function(
      `return import(${JSON.stringify(specifier)})`,
    )() as Record<string, unknown>;
  } catch {
    return null;
  }

  try {
    const pipeline = module.pipeline as (
      task: string,
      model: string,
      options?: Record<string, unknown>,
    ) => Promise<(texts: string[], options: Record<string, unknown>) => {
      tolist: () => number[][];
    }>;
    const extractor = await pipeline("feature-extraction", modelPath, {
      quantized: true,
      dtype: "q8",
    });
    return {
      kind: "transformers",
      async embedMany(texts: string[]): Promise<number[][]> {
        const output = await extractor(texts, { pooling: "mean", normalize: true });
        return output.tolist();
      },
    };
  } catch {
    return null;
  }
}
