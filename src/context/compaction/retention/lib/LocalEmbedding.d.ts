export type LocalEmbedding = {
    readonly kind: "transformers" | "lexical";
    embedMany(texts: string[]): Promise<number[][]>;
};
/**
 * Offline lexical embedding fallback. It is deterministic and dependency-free;
 * it exists so Hippo still runs when the Transformer.js model is not present.
 */
export declare class LexicalEmbedding implements LocalEmbedding {
    readonly kind: "lexical";
    embedMany(texts: string[]): Promise<number[][]>;
}
export declare function defaultEmbeddingModelPath(): string;
/** Test hook: memoized load promises keyed by model path. */
export declare const embeddingLoadCacheForTests: Map<string, Promise<LocalEmbedding | null>>;
export declare function tryLoadTransformersEmbedding(): Promise<LocalEmbedding | null>;
