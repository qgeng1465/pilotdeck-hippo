/** Deterministic BM25 lexical relevance used when a neural embedding is absent. */
export declare function bm25Relevance(queryText: string, documentTexts: string[]): number[];
export type EbbinghausScoreInput = {
    candidates: Array<{
        text: string;
        index: number;
    }>;
    queryText: string;
    recencyScores: number[];
    coreScores: number[];
    semanticScores: number[];
    weights: {
        wSim: number;
        wTime: number;
        wRank: number;
    };
};
export declare function ebbinghausScore(input: EbbinghausScoreInput): number[];
