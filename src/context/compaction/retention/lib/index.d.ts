/**
 * Public surface of the `hippo-retention` package.
 *
 * Everything a consumer needs is re-exported here — including the names that
 * used to be reachable only by importing a file deep inside the directory
 * (`defaultEmbeddingModelPath`, `embeddingLoadCacheForTests`,
 * `EBBINGHAUS_DEFAULT_WEIGHTS`). Keeping the barrel complete is what lets the
 * host treat this as a package rather than a path.
 */
export { buildEbbinghausPageRankPolicy, EbbinghausPageRankPolicy, EBBINGHAUS_DEFAULT_WEIGHTS, resolveRetentionScorePolicy, } from "./EbbinghausPageRankPolicy.js";
export type { EbbinghausPolicyOptions, RetentionScorePolicy } from "./RetentionTypes.js";
export { CARRYOVER_BUDGET_SHARE, isCarryOverEnabled, isHippoRetained, withHippoRetainedMarker, } from "./CarryOver.js";
export { EntityGraph } from "./EntityGraph.js";
export type { EntityGraphOptions } from "./EntityGraph.js";
export { bm25Relevance, ebbinghausScore } from "./EbbinghausScore.js";
export type { EbbinghausScoreInput } from "./EbbinghausScore.js";
export { LexicalEmbedding, tryLoadTransformersEmbedding, defaultEmbeddingModelPath, embeddingLoadCacheForTests, } from "./LocalEmbedding.js";
export type { LocalEmbedding } from "./LocalEmbedding.js";
export { messageVisibleText } from "./MessageText.js";
export { COMPACTION_CONTINUATION_TEXT, INTERNAL_USER_TEXT_PREFIXES, isSyntheticPseudoMessage, } from "./PseudoMessage.js";
export type { HippoContentBlock, HippoMessage } from "./HippoMessage.js";
