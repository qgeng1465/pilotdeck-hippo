import type { HippoMessage } from "./HippoMessage.js";
import type { EbbinghausPolicyOptions, RetentionScorePolicy } from "./RetentionTypes.js";
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
 * There 0.85/0.15/0 is >= the previous 0.7/0.15/0.15 in all four
 * (language x size) cells — 9.4/17.9/6.0/10.0 vs 9.3/17.7/6.0/9.5.
 *
 * Read those two rows honestly: across the 40 per-seed pairings the difference
 * is 7 wins / 33 ties / 0 losses, and no cell is significant (p = 1 / 0.5 / 1 /
 * 0.125). So re-weighting is NOT a measured improvement and must not be
 * advertised as one. What the holdout does establish is the mechanism: against
 * upstream, all four cells are 10 wins / 0 ties / 0 losses at p = 0.002. The
 * reasons to prefer this triple are that it is the grid argmax and that it is
 * simpler — two nonzero terms instead of three.
 *
 * The PageRank term is therefore no longer weighted by default, but it is kept
 * in the policy: it is the only query-independent signal available, and the
 * no-query probe in tune.ts shows it is the least-bad term when there is no
 * pending request to score against — a regime where every variant sits near
 * the floor (<=3/20). `idfCorrection` still applies whenever the term is used.
 *
 * That regime used to be reachable by accident and no longer is:
 * `CompactionEngine` derived the query hint from the tail alone, so a compaction
 * triggered by a long tool output (no user message in the tail) scored every
 * candidate against an empty query — measured at 0.00-0.20 of 20 facts kept.
 * It now falls back to the most recent real user request in the conversation.
 * Regression test: `tests/context/hippo-retention.spec.ts`, "retention is still
 * query-conditioned when the tail holds no user request".
 *
 * Anyone re-tuning: change the numbers only with a `benchmark:tune` run *and*
 * a `benchmark:holdout` run, in that order.
 */
export declare const EBBINGHAUS_DEFAULT_WEIGHTS: {
    readonly wSim: 0.85;
    readonly wTime: 0.15;
    readonly wRank: 0;
};
export declare class EbbinghausPageRankPolicy<M extends HippoMessage = HippoMessage> implements RetentionScorePolicy<M> {
    private readonly options;
    readonly id = "ebbinghaus-pagerank";
    constructor(options?: EbbinghausPolicyOptions);
    /** Effective (normalized) weights actually used when scoring. */
    get weights(): {
        wSim: number;
        wTime: number;
        wRank: number;
    };
    scoreMessages(input: {
        candidates: M[];
        queryHint?: string;
    }): Promise<Map<M, number>>;
    pickRetained(input: {
        candidates: M[];
        retentionBudgetTokens: number;
        queryHint?: string;
        estimateTokens: (candidates: M[]) => number;
    }): Promise<M[]>;
    private score;
}
export declare function buildEbbinghausPageRankPolicy<M extends HippoMessage = HippoMessage>(options?: EbbinghausPolicyOptions): EbbinghausPageRankPolicy<M>;
/**
 * Resolve the app-level retention switch (`agent.compaction.retention` in
 * ~/.pilotdeck/pilotdeck.yaml). This fork defaults to the Hippo policy;
 * `off` restores plain upstream compaction. The engine-level API stays
 * opt-in — constructing a CompactionEngine without `scorePolicy` keeps
 * upstream behavior byte-for-byte, which `benchmark:no-regression` guards.
 */
export declare function resolveRetentionScorePolicy<M extends HippoMessage = HippoMessage>(compaction: {
    retention?: "hippo" | "off";
} | undefined): RetentionScorePolicy<M> | undefined;
