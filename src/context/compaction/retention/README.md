# hippo-retention

Scoring policy that decides **which messages a compaction should keep verbatim**
instead of folding into the summary.

An agent that compacts its context keeps the recent tail and summarises the rest.
A summary keeps the gist and loses the things that must stay exact — file names,
numbers, checkpoints, decisions. This package scores the messages that are about
to be summarised and returns a small, budget-bounded batch whose **original text**
skips summarisation. See the repository README for the measured effect and its
cost (retention is *paid for* in tokens, not saved).

It is a plain library: no I/O, no host types, no runtime dependencies.

## Import

In this repository it is a workspace package, so the name just resolves:

```ts
import {
  buildEbbinghausPageRankPolicy,
  messageVisibleText,
} from "hippo-retention";
```

On its own, `pnpm pack` (or `npm pack`) the directory and install the tarball —
the built `lib/` is committed, so no build step is needed to consume it:

```bash
pnpm pack                                  # -> hippo-retention-0.1.0.tgz
npm install /path/to/hippo-retention-0.1.0.tgz
```

Building it standalone (`pnpm run build`) needs `typescript` and `@types/node`;
those are `devDependencies` and are not installed for consumers.

## Use

The policy is a single interface, `RetentionScorePolicy<M>`, parameterised by
*your* message type. Nothing has to be adapted or cast: any message with a
`role` and a `content` block array satisfies `HippoMessage`, the default type
parameter.

```ts
import { buildEbbinghausPageRankPolicy } from "hippo-retention";

const policy = buildEbbinghausPageRankPolicy();   // or <MyMessage>() to bind it

const keep = await policy.pickRetained({
  candidates,                       // messages about to be summarised
  retentionBudgetTokens: 2048,
  queryHint: "what was the p99 again?",
  estimateTokens: (messages) => estimate(messages),
});
// `keep` is a subset of `candidates`, in eligibility order for the budget.
```

`scoreMessages({ candidates, queryHint })` exposes the raw per-message scores
behind that choice.

Optional environment switches, both read at call time:

| Variable | Effect |
|---|---|
| `PILOTDECK_BGE_MODEL` | Path/HF id of a local embedding model. When set (and loadable) the semantic term is embedding cosine; otherwise it falls back to BM25. A load that takes longer than 15 s is treated as failure and falls back silently. |
| `PILOTDECK_CARRYOVER` | `off` / `0` / `false` / `no` / `disabled` disables the carry-over allowance (a capped slice of the budget reserved for messages a previous compaction kept verbatim). |

## Layout

| File | Role |
|---|---|
| `EbbinghausPageRankPolicy.ts` | The policy: weights, budget fill, carry-over allowance |
| `EbbinghausScore.ts` | The weighted score (similarity / recency / centrality) and BM25 |
| `EntityGraph.ts` | Bilingual entity extraction, DF pruning, IDF-PageRank |
| `LocalEmbedding.ts` | Transformer.js embedding loader and BM25 fallback |
| `MessageText.ts` | The single text view every score is computed on |
| `RetentionTypes.ts` | `RetentionScorePolicy<M>` and the policy options |
| `CarryOver.ts` | Multi-round carry-over marker and its budget share |
| `PseudoMessage.ts` | Runtime bookkeeping that must never be retained verbatim |
| `HippoMessage.ts` | The minimal message contract (zero imports) |

## Honesty notes

The default weights, and why they are *not* claimed to be an improvement, are
documented in the comment on `EBBINGHAUS_DEFAULT_WEIGHTS`. The short version: the
holdout pairings against the previous triple are 5 wins / 35 ties / 0 losses, so
re-weighting is a tie-breaker, not a measured gain; what the holdout does
establish is the difference against having no retention at all.

`thinking` blocks are deliberately excluded from `messageVisibleText`: they are
not replayed as visible content, so scoring on them would select and charge
budget for text the model never receives.
