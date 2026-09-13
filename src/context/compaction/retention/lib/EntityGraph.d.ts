export type EntityGraphOptions = {
    windowSize?: number;
    /** CJK entities appearing in more than this fraction of messages are pruned as stop-words. */
    cjkMaxDocumentFrequency?: number;
    /** Minimum number of CJK-bearing messages before document-frequency pruning kicks in. */
    cjkMinMessagesForPruning?: number;
};
export declare class EntityGraph {
    private readonly adjacency;
    private messageEntities;
    private normalizedRank;
    private entityDocumentFrequency;
    private totalMessageCount;
    build(messages: Array<{
        text: string;
    }>, options?: EntityGraphOptions): this;
    pageRank(options?: {
        iterations?: number;
        damping?: number;
    }): Map<string, number>;
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
    messageRankScores(options?: {
        idfCorrection?: boolean;
    }): number[];
    rankForMessage(messageIndex: number): number;
    /** Extracted (post-pruning) entities of one message; exposed for tests and UI visualization. */
    entitiesForMessage(messageIndex: number): string[];
}
