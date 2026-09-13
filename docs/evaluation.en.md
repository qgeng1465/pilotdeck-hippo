# Benchmark Protocol and Results (full record)

This is the full record behind the numbers in the main README: protocols, tables, sensitivity analysis and honest boundaries, all kept verbatim.
Every figure traces to a committed `benchmarks/results/*.json`, reconcilable row by row via the audit index at the end.
The main README keeps only the overview; this file is its expansion — back to [../README.md](../README.md).

## 4. Benchmark Approaches and Results

### 4.1 Structural stress test (fake summarizer)

Synthetic bioinformatics dialogues scatter 20 precise facts across the first ~75% of messages; the tail asks for verbatim reproduction. The fake summarizer never emits FACT text, so upstream 0/20 is a *structural* contrast ("lossy summary vs verbatim retention"), not a ceiling on what a real summarizer can do. The table below is the **median** produced by `pnpm benchmark` (seed=20260911), from `benchmarks/results/ab-2026-09-12.json`; the fact column was re-measured on 2026-09-12 after the fact-marker prefix collision was fixed (§4.10), and the three token columns are bit-identical to before:

| N | Pre-compaction tokens | Upstream post | Hippo post | Fact retention /20 (upstream → Hippo) |
|---:|---:|---:|---:|---:|
| 40 | 3,906 | 1,153 | 1,381 | 0 → 6 |
| 80 | 8,291 | 2,368 | 2,634 | 0 → 7 |
| 160 | 17,034 | 4,739 | 5,339 | 0 → 16 |

I.e. Hippo trades ~1.11–1.20× post-compaction tokens for verbatim facts; every run is deterministic (`true`). **The cost is stated plainly**: this 11–20% is extra, not saved — Hippo buys "facts still reproducibly verbatim after compaction", not "compresses harder".

### 4.1a Extraction precision (per-message precision/recall): the direct answer to "how do you guarantee accurate extraction"

The `0/20→6/7/16` above is **recall** — how many of the 20 facts the query must reproduce survive; it does not say whether the retention block is mostly the right messages. This section measures precision/recall at message granularity from the engine's own `retention.retainedMessageTexts` (the messages scoring selected and actually entering the post-compaction context, **not reconstructed from the fingerprint — no reconstruction artifacts**), on held-out seeds (2026-09-21+) via `pnpm benchmark:extraction` (JSON: `benchmarks/results/extraction-precision-2026-09-12.json`, re-measured after the fix on 2026-09-12; the recall column is unchanged, only lift moves in its last digit as the chance baseline does — see §4.10):

| lang | N | Recall (fraction kept) | Precision (relevant share of retained block) | Random baseline | Lift over random |
|---|---:|---:|---:|---:|---:|
| en | 40 | 6/20 | **100%** | 36% | 2.8× |
| en | 80 | 7/20 | **100%** | 18% | 5.7× |
| en | 160 | 16/20 | **100%** | 9% | 11.1× |
| zh | 40 | 4/20 | **100%** | 37% | 2.7× |
| zh | 80 | 4/20 | **100%** | 18% | 5.6× |
| zh | 160 | 8/20 | **89%** | 9% | 10× |

(Recall differs slightly from §4.1: that is the seed-20260911 tuning protocol; this is held-out seeds, counted by "messages" rather than "markers"; both are within-budget recall.)

1. **High precision = the scoring really separates signal from noise**: the retained block is almost entirely fact messages the current query needs (only zh N=160 sneaks in one noise message), 2.7–11.1× over random — it is not dumping the whole history back in.
2. **Recall is bounded by the token budget**: the retention budget (≤256 tok, actually using 88–99%) only fits 4–16 messages. **The cost is explicit**: keep the most relevant, can't hold everything — the same trade-off as the main benchmark's "pay tokens for fidelity" (1.11–1.20×).
3. **What it guarantees**: this does not guarantee correct selection on arbitrary real tasks — the scorer is still an unsupervised heuristic. What it *does* guarantee are the two measurable things — **once selected, almost necessarily relevant (precision) and verbatim-lossless (per §4.1); the costs and boundaries are written in the table**.

### 4.2 Component ablation

Splitting the same formula apart, re-run on identical transcripts (protocol: EN+ZH, N=40/80/160, 10 seeds; medians. From `benchmarks/results/ablation-2026-09-12.json`, re-measured on 2026-09-12 after the fact-marker prefix collision was fixed, §4.10):

| Variant | EN N=160 | EN N=80 | ZH N=160 | ZH N=80 |
|---|---:|---:|---:|---:|
| sim only | 16 | 7 | 8 | 4 |
| time only | 1 | 1 | 1 | 1 |
| rank only (raw PageRank) | 0 | 0 | 0 | 0 |
| rank only (+IDF) | 0 | 0 | 1 | 1 |
| full (old default 0.4/0.35/0.25) | 8.5 | 4.5 | 4 | 3 |
| **full (current default 0.85/0.15/0.00)** | **16** | **7** | **8** | **4** |

(Medians under the tuning protocol. Note the `sim only` column is cell-for-cell identical to the current default — under this protocol adding the 0.15 time weight does not move the median. The `0.7/0.15/0.15` variant is not listed here — its difference from the current default is tested by a *hold-out* paired comparison, §4.5 row 4 and item 3 below; the two protocols' numbers are not mixed.)

Three problems the ablation surfaced, and what was done about them:

1. **Hub dilution**: the hubs of raw PageRank are repeated noise (QC, Step, and other tokens appearing in every message); the fact messages' unique entities score low — rank alone scores 0. After IDF correction the Chinese rank term recovers signal (ZH N=40: 0 → 2.5).
2. **The time term does not pay for itself**: `pnpm benchmark:tune` re-anchored over an 18-config grid (N=80 × 3 seeds × 2 langs; re-measured after the fix, JSON: `benchmarks/results/tune-2026-09-12.json`). The pre-fix reading recorded the argmax as `0.85/0.15/0.00` = `72/120`; the corrected grid's argmax is a **nine-way tie at `63/120`** — every `S{0.55,0.7,0.85}/T0/R*` scores 63 (`en=39, zh=24`), i.e. **every `T=0` config sits at or above every `T=0.15` config**; the current default `S0.85/T0.15/R0` scores **`60/120`**, mid-grid. The one thing the corrected grid supports is: **on this protocol the time term does not pay for its weight** — it no longer backs the current default. (The old `72/120, first place` was an inflated reading from the fact-marker prefix collision, §4.10, and is wrong; the §4.2 table lists only 4 cells for layout — the full 6 including N=40 are in the ablation JSON.)
3. **The default is neither the argmax nor picked out by the grid** (found by the hold-out re-check): the corrected grid's argmax is the all-`T=0` nine-way tie at 63/120, while `0.85/0.15/0.00` in the code scores 60/120. On never-tuned seeds 20260921–20260930, one-to-one paired comparison (§4.5): the `T=0` proxy is the variant named `sim only` (i.e. `S1/T0/R0`); against the current default it is **en N=160 15.9 vs 15.9, zh N=160 8.0 vs 8.0, zh N=80 4.0 vs 4.0 — three exact ties — and en N=80 7.0 vs 7.4, 0.4 apart** — on unseen seeds the two are indistinguishable.

   **What was done**: `EBBINGHAUS_DEFAULT_WEIGHTS` stays `{0.85, 0.15, 0}`; it was **not** changed to `T=0`. This is a decision, not an optimum: the frozen shipped configuration, the ablation table and the recorded demo all rest on it, rewriting it now would invalidate every measurement, and the unseen-seed evidence (three ties and one 0.4 gap) does not support a change. The rank term is **still not deleted**, its weight just goes to 0, and the formula, entity-graph code and the `wRank` config all remain, re-enable with one line of config. Plus a mechanical guard: in `holdout.ts` the "current default" row reads the `EBBINGHAUS_DEFAULT_WEIGHTS` constant directly instead of a copied literal, so **any future default drift shows up directly in the hold-out table**.

   **Honest boundary**: the argument here is "**no difference**", **not** "tuning brought an improvement" — `T=0` and the current default tie in three cells and differ by 0.4 in one, so neither is better; keeping the current default is a continuity decision. The contrast vs upstream (no retention) — 15.9 / 7.4 / 8.0 / 4.0 — is this work's main effect: all four cells 10 wins 0 ties 0 losses, p=0.002.

4. **Retention degenerates without a query** (newly found and fixed this round): compaction isn't always triggered by a new user request — one very long tool output blowing the budget triggers it too. Then there is no user message in the tail window, `queryHint` degenerates to an empty string, and the similarity term goes to zero: the hold-out no-query probe shows the current default keeps only **0.00–0.10 / 20** facts, while pure `sim` can keep 1–2. This is not a weighting problem — putting the rank weight back doesn't rescue the main path (see above).

   **How it was fixed**: fix the cause, not the weight. `CompactionEngine` now, when the tail yields no real user request, falls back to the **most recent real user request in the whole conversation** (still the request that the compacted messages serve), rather than an empty string. The regression test `tests/context/hippo-retention.spec.ts` "retention is still query-conditioned when the tail holds no user request" fails deterministically when the fix is reverted (the policy receives `""` in practice) and passes with it. Incidentally this reveals where the rank term genuinely has signal: precisely in the no-query regime (Chinese no-query probe: rank+IDF 2.0/20 vs sim-only 1.0/20; English 0–0.4/20) — but that regime is now eliminated at the engine level.

### 4.3 Real-LLM closed loop (two rounds, with sensitivity)

Summarizer and judge are both DeepSeek-V4-Flash (temperature 0); each cell = 2 seeds, 16 questions total. A model that both summarizes and judges introduces model bias; the numbers below are a reproducible experimental record, not a substitute for independent judgment or human spot-checks. On the same day we ran one round on each of two endpoints; **the fact that results differ is itself evidence that single-round real-LLM numbers are not extrapolable**; both JSONs are committed (`benchmarks/results/real-llm-*.json`, including endpoint source and token spend). Both rounds share the same code and the same summary output cap of **4,000 tok/call** (`benchmarks/realLlmEval.ts`). Two honest notes: Round A's JSON has **no `endpoint` field** (the script didn't write it at the time), and **neither JSON has `finish_reason`** — the script had *computed* `summaryTruncated` but only `console.log`'d it, never persisted it; this round we fixed it to persist both, along with each cell/call's completion count, so next round the cap is directly measurable.

Round A — official API. All 8/8 cells record completion of exactly **2,400 = 2 calls × 1,200** (`en/zh × N=80/160 × upstream/Hippo` all identical). Complete constancy across all 8 cells is a **cap signature**, not model choice; but the A-round cap value actually in effect cannot be found in the repo (that round didn't record it; the code value is 4,000), so "the summary was truncated" **remains inference, not measurement**:

| lang | N | Upstream | Hippo |
|---|---:|---|---|
| en | 80 | 68.8% (11/16), 2,904 tok | 68.8% (11/16), 3,081 tok |
| en | 160 | 12.5% (2/16), 4,977 tok | **87.5% (14/16)**, 5,769 tok |
| zh | 80 | 0% (0/16), 2,340 tok | 18.8% (3/16), 2,319 tok |
| zh | 160 | 0% (0/16), 4,002 tok | **81.3% (13/16)**, 4,964 tok |

Round B — a self-hosted gateway endpoint, summary cap 4,000 tok/call, **16 summary calls per round** (8 cells × 2 seeds). This time the cap is directly readable from the JSON: the `zh/80 upstream` cell is exactly 8,000 = 2 × 4,000 — both calls capped; the other 7 cells total 5,266–7,335, all > 4,000, so **at least 8 of 16 calls hit the cap**:

| lang | N | Upstream | Hippo |
|---|---:|---|---|
| en | 80 | 100% (16/16), 3,402 tok | 100% (16/16), 3,704 tok |
| en | 160 | 100% (16/16), 5,955 tok | 100% (16/16), 6,278 tok |
| zh | 80 | 0% (0/16), 2,075 tok | **62.5% (10/16)**, 2,958 tok |
| zh | 160 | 31.3% (5/16), 4,586 tok | **56.3% (9/16)**, 4,912 tok |

Three readings across both rounds:

1. **On Chinese, Hippo wins consistently across both rounds (4/4 cells)**. When v4-flash writes a Chinese summary it doesn't reproduce numeric facts verbatim (upstream post-compaction FACT markers 0/20); Hippo's retention block brings the verbatim text back into context.
2. **On English, the result varies with summary length**. Round A's summaries were short (1,200 tok/call, constant across 8/8 cells) and upstream N=160 was only 12.5%; in Round B — summaries more than twice as long (≥2,633 tok/call) — upstream returns to 100%, and post-compaction tokens rise (en N=160: 4,977 → 5,955). **Length and score moving together is measured; the causal explanation remains inference**: the most natural one is that A-round summaries were truncated and, with more room in B, upstream recovered by "copying checkpoints into a longer summary". But A's actual cap value can't be found in the repo, so we don't write it as a conclusion here. What we can confirm is the direction of cost — upstream must pay for longer summaries to hold precise facts; Hippo reaches the same goal with a budget-capped verbatim retention block.
3. **Variance statement**: only 16 questions/cell, 2 seeds, same-model judge, and the two endpoints (official API vs self-hosted gateway) may differ in service characteristics. So we only state directional conclusions (Chinese stable win; English varies with summary budget), and do not claim a single "improved X points".

### 4.4 Scoring latency (efficiency cost)

Policy scoring is local computation, median latency: EN ≈ 19–53 ms, ZH ≈ 139–387 ms (measured extremes of `wallMsMedian` in the 2026-09-12 re-measured ablation JSON, N=40→160; Chinese bigram entity counts run ~5–10× English, so a bigger graph). Two consecutive runs of the same configuration agree bit for bit on fact counts and tokens; only the wall-clock column jitters by a few milliseconds. Compared with one real LLM summary call (seconds), scoring overhead is ≈5–15%, and compaction is a low-frequency event. Optimization paths (per-message entity truncation, fewer PageRank iterations) are already parameterized. Measure: `pnpm benchmark:ablation` (wall ms column); machine specifics in the result JSON.

### 4.5 Holdout validation (seeds used for parameter selection are never used)

The §4.2 tables pick weights on a seed batch and then report scores on that same batch — that only shows "fits well", nothing else. This section separates the two concerns:

- **Protocol**: `SEEN_SEED_MAX = 20260920`, `HOLDOUT_SEED_BASE = 20260921`. Tuning/ablation uses only seeds ≤ 20260920; the holdout set always takes seeds 20260921–20260930 (10 seeds), **never used in any selection** (weights, IDF switch, PageRank iteration count included).
- **Statistics**: each seed is paired with itself (same seed, same transcript, only the strategy changes); we report per-seed deltas, win/tie/loss and a **two-sided exact sign-test p**. With 10 seeds the smallest possible sign-test p is 0.002, so p=0.002 means "won all 10", not "huge effect size".
- **Verifiable**: `pnpm benchmark:holdout`; the table here is from `benchmarks/results/holdout-2026-09-12.json` (re-measured on 2026-09-12 after the fact-marker prefix collision was fixed, §4.10; the pre-fix run of the same name now lives in `benchmarks/results/superseded-pre-fix/`).

Holdout table by variant (mean / 20 facts, 10 seeds):

| lang | N | Variant | Retained | sd | min | max | Post-compaction tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| en | 80 | upstream (no retention) | 0 | 0 | 0 | 0 | 2,362 |
| en | 80 | old default 0.4/0.35/0.25 | 4.6 | 1.35 | 3 | 7 | 2,641 |
| en | 80 | previous default 0.7/0.15/0.15 | 7.3 | 0.48 | 7 | 8 | 2,637 |
| en | 80 | **current default 0.85/0.15/0.00** | **7.4** | 0.52 | 7 | 8 | 2,641 |
| en | 160 | upstream (no retention) | 0 | 0 | 0 | 0 | 4,753 |
| en | 160 | old default 0.4/0.35/0.25 | 8.8 | 0.63 | 8 | 10 | 5,349 |
| en | 160 | previous default 0.7/0.15/0.15 | 15.9 | 0.32 | 15 | 16 | 5,355 |
| en | 160 | **current default 0.85/0.15/0.00** | **15.9** | 0.32 | 15 | 16 | 5,355 |
| zh | 80 | upstream (no retention) | 0 | 0 | 0 | 0 | 2,148 |
| zh | 80 | old default 0.4/0.35/0.25 | 3.1 | 0.57 | 2 | 4 | 2,394 |
| zh | 80 | previous default 0.7/0.15/0.15 | 4.0 | 0 | 4 | 4 | 2,393 |
| zh | 80 | **current default 0.85/0.15/0.00** | **4.0** | 0 | 4 | 4 | 2,392 |
| zh | 160 | upstream (no retention) | 0 | 0 | 0 | 0 | 4,088 |
| zh | 160 | old default 0.4/0.35/0.25 | 3.9 | 0.57 | 3 | 5 | 4,604 |
| zh | 160 | previous default 0.7/0.15/0.15 | 7.5 | 0.71 | 6 | 8 | 4,609 |
| zh | 160 | **current default 0.85/0.15/0.00** | **8.0** | 0 | 8 | 8 | 4,610 |

Paired comparisons (each seed as its own control):

| Comparison | en N=80 | en N=160 | zh N=80 | zh N=160 |
|---|---:|---:|---:|---:|
| current default vs upstream | +7.4 (10/0/0, p=.002) | +15.9 (10/0/0, p=.002) | +4.0 (10/0/0, p=.002) | +8.0 (10/0/0, p=.002) |
| old default vs upstream | +4.6 (10/0/0, p=.002) | +8.8 (10/0/0, p=.002) | +3.1 (10/0/0, p=.002) | +3.9 (10/0/0, p=.002) |
| current default vs old default | +2.8 (9/1/0, p=.004) | +7.1 (10/0/0, p=.002) | +0.9 (8/2/0, p=.008) | +4.1 (10/0/0, p=.002) |
| current vs previous default 0.7/0.15/0.15 | +0.1 (1/9/0, p=1) | 0 (0/10/0, p=1) | 0 (0/10/0, p=1) | +0.5 (4/6/0, p=.125) |

**How to read — and how NOT to read — this table**:

- The main effect is **row one**: no retention → verbatim retention, 10 wins 0 ties 0 losses in all four cells. This is the claim we put out publicly. Every mean is 2.0 lower after the fix (`15.9 / 7.4 / 8.0 / 4.0`), with direction and significance unchanged; that 2.0 is exactly the ceiling of the prefix-collision inflation (§4.10).
- Row three (vs old default 0.4/0.35/0.25) is also solid, with no loss in any of the four EN+ZH cells (9/1/0, 10/0/0, 8/2/0, 10/0/0), each effect also 2.0 smaller — the old default gave 0.25 to the rank term, letting rank dilute `sim`; that was the real weight mismatch.
- **Row four must be read as "no difference"**: 5 wins 35 ties 0 losses, p = 1 / 1 / 1 / 0.125, none significant. The legitimate reason the default stays at 0.85/0.15/0.00 is "consistency with the frozen shipped configuration + one fewer term", **not** "it improved the score", and **no longer** "it aligns with the tuning argmax" — the corrected tuning grid no longer points at it (§4.2 item 3). Any claim that "weight tuning brought a significant improvement" contradicts this table.
- zh N=80 / zh N=160 have sd = 0 (all 10 seeds identical). This is not high precision; in the Chinese cells the retained messages concentrate on the same few typical facts. When reading Chinese numbers, look at the overall direction across the 10 seeds, not decimal-place differences.

### 4.6 Topic switching: how much of an old topic survives

The transcripts in earlier sections run "one topic all the way". Real use more often means **switching topics mid-way**: the first half is topic A, the tail starts asking about B, and at compaction only B's request is in hand. Then A-segment messages get **no query relevance for their own topic** — they can only compete for the leftover budget through residual similarity.

Protocol: 10 hold-out seeds, 10 facts per topic (20 total), A then B, and the pending request at compaction is B's. Script `pnpm benchmark:topic-switch`, table from `benchmarks/results/topic-switch-2026-09-12.json`; mechanism-diagnosis script `pnpm benchmark:topic-diagnosis`, from `benchmarks/results/topic-diagnosis-2026-09-12.json`. Both JSONs were re-measured on 2026-09-12 after the fact-marker prefix collision was fixed (§4.10), and the table below carries the re-measured values.

**This table has two fact phrasings and must be read with both — citing only one half gives a wrong conclusion**:

| N | Fact phrasing | Variant | Topic A verbatim retained | Topic B verbatim retained | Post-compaction tokens |
|---:|---|---|---:|---:|---:|
| 80 | shared | upstream | 0 | 5 | 1,844 |
| 80 | shared | Hippo | 1 | **10** | 2,095 |
| 160 | shared | upstream | 0 | 5 | 3,451 |
| 160 | shared | Hippo | 4.9 | **10** | 3,889 |
| 80 | **decorrelated** | upstream | 0 | 5 | 1,798 |
| 80 | **decorrelated** | Hippo | **0** | **10** | 2,053 |
| 160 | **decorrelated** | upstream | 0 | 5 | 3,398 |
| 160 | **decorrelated** | Hippo | **0** | **10** | 3,827 |

`shared` = the original phrasing: both topics' facts share one field template (`cohort=… n=371 gene=… freq=… stat=…`) and the pending request reuses that vocabulary. `decorrelated` = each topic has its own field words and marker words, and the request only uses B's words, so **topic becomes the only factor distinguishing A from B facts**.

Three readings:

1. **The topic-A column (1 and 4.9 under `shared`) is a harness artifact that collapses to zero under `decorrelated`**. Diagnostic evidence: in single-term ablation `time only` and `rank only` are both **0/10**, `sim only` alone reproduces 5.0/10; surviving facts' mean position in the A segment is 0.58 (no "closer = more kept" tendency), further ruling out recency; and directly measuring BM25, A-facts against the B request score **0.820** while A-segment filler messages score **0.240**; rewriting the same facts as prose without the shared field labels drops them to **0.370** — i.e. (0.820 − 0.370) / (0.820 − 0.240) ≈ **78% of the similarity gap comes from the shared template** (using A-segment filler's 0.240 as the baseline in the denominator). Once this lexical bridge is removed, the A column is **0/10**, matching upstream. **So do not publicly say "Hippo remembered the old topic" — it does not.**
2. **The only conclusion that holds in both directions is in the B column: 5/10 → 10/10**. In the post-compaction context, *current*-topic precise facts are retained verbatim, while upstream under this stub summarizer only gets 5/10. This shares its origin with the §4.1 main effect: **the benefit is fidelity to the current task, not memory of old context.** (Tokens also drop slightly under `decorrelated`, since budget is no longer spent on the A segment.) **But this 5/10 has a stub-summarizer component**: in §4.7, with a real summarizer, upstream's current topic is also all correct, so read the B column as a structural contrast "verbatim retention block vs stub summary", not as "how many more questions the user can answer".
3. **Two honest boundaries, marked rather than dodged**:
   - This harness uses a fixed-text stub summarizer, and **the summary cannot carry facts by construction**, so the two `summary-only` arms are both 0, and the verbatim column is the entire conclusion. This table only answers "does the verbatim retention block contain facts", not "can the user answer questions correctly under a real summarizer". **That boundary has been closed**: `benchmark:real-llm-topic-switch` (§4.7) re-runs the same experiment with a real summarizer and yields a **conditional** — when the summary budget is generous the B-column advantage does not hold (the real summarizer writes the facts into the summary itself, and upstream's current topic is also all correct); when the budget is tight the B-column advantage holds in its cleanest form (current topic 10/16 → 16/16, both phrasings, same direction). So read the B column as "what a verbatim retention block saves over a lossy summary when the budget is tight", not as an unconditional "how many more questions the user answers".
   - `decorrelated` is a phrasing variant we **added** in order to fix item 1; it is itself a human choice. Listing both phrasings is precisely to expose how sensitive the conclusion is to phrasing. We only assert the old-topic retention of 0 under the premise that "fact phrasing doesn't leak the topic".

### 4.7 Topic switching under a real summarizer (a supplement to the first boundary of §4.6)

§4.6 used a stub summarizer, so it has nothing to say about "can the user still answer old-topic questions under a real summarizer". This section swaps the summarizer for a real model and re-runs the same experiment. **The result splits in half, and both halves must be told**: with a generous budget it falsifies our claim (old-topic recovery is not our doing); with a tight budget it yields the cleanest positive conclusion in this repo (current topic 10/16 → 16/16). Script `pnpm benchmark:real-llm-topic-switch`; both JSONs are committed.

Protocol: `N/topic=160`, 10 facts per topic, 4 questions on topic A and 4 on topic B per case; 2 hold-out seeds × **2 repeats** (the repeat is the criterion, below); summarizer and judge both DeepSeek-V4-Flash. The two rounds differ in exactly one variable — the summary output budget (`PILOTDECK_EVAL_SUMMARY_TOKENS`).

| Round (summary budget) | Phrasing | Variant | Current topic B correct | B two repeats | B-facts in retention zone (median/10) | Topic A correct | Summary capped (rows/4) |
|---|---|---:|---|---:|---:|---:|---:|
| **generous 8000 tok** | shared | upstream | 16/16 | 8, 8 | 6 | 11/16 | 0 |
| generous 8000 tok | shared | Hippo | 16/16 | 8, 8 | 8 | 16/16 | 0 |
| generous 8000 tok | decorrelated | upstream | 16/16 | 8, 8 | 6 | 16/16 | 0 |
| generous 8000 tok | decorrelated | Hippo | 16/16 | 8, 8 | 8 | 12/16 | 0 |
| **tight 1500 tok** | shared | upstream | **10/16** | 4, 6 | 6 | 0/16 | 3 |
| tight 1500 tok | shared | Hippo | **16/16** | 8, 8 | 8 | 8/16 | 4 |
| tight 1500 tok | decorrelated | upstream | **10/16** | 6, 4 | 6 | 1/16 | 3 |
| tight 1500 tok | decorrelated | Hippo | **16/16** | 8, 8 | 8 | 0/16 | 4 |

Data: generous round `benchmarks/results/real-llm-topic-switch-2026-09-11T12-29-27-528Z.json`, tight round `benchmarks/results/real-llm-topic-switch-2026-09-11T12-45-03-182Z.json`.

**The criterion precedes the result**: this harness has built-in repeats, and the rule was set before looking at the numbers — **only read a direction when the between-arm gap exceeds the within-repeat swing of the same config**. By that rule:

1. **Generous budget (8000): the consistent conclusion is "no difference".** Current topic all four arms 16/16 (ceiling — no difference expected), old topic upstream 27/32 vs Hippo 28/32 (1 question apart); but same-config within-repeat swing is 3–4 questions (`shared/upstream` A-column 4 and 7, `decorrelated/Hippo` 4 and 8). **Swing > arm gap ⇒ no direction claimed.**
2. **Tight budget (1500): swing < arm gap, so this one is claimable.** Current topic: upstream 10/16 in both phrasings (repeats 4/6 and 6/4); Hippo **16/16 in both phrasings, both repeats, four repeats with zero swing**. Arm gap of 6 ≈ 3× upstream's own swing, and both phrasings point the same way. Same direction and mechanism as §4.3 Round A (short summary, Chinese 0% → 81.3%).
3. **The most honest mechanistic statement: the two tight rounds cap the summary almost equally (upstream 3, Hippo 4 / of 4 cases)**, so "upstream is truncated, Hippo isn't" is not the explanation. The explanation is in the retention-zone column: both arms' summaries got cut, **but Hippo additionally has a verbatim retained current-topic checkpoint (retention-zone counts: Hippo ≤8/10, upstream ≤6/10, tail-only); whether the summary finished writing doesn't affect it. The value of retention shows up when the summarizer can't hold the budget — not when it can.**
4. **The old-topic half is still a negative, and three harnesses corroborate it.** In the generous round, "old topic still answerable" is **the real summarizer transcribing it into its own summary**: both upstream arms have zero retention counts on the old topic (they have no retention block), and under `decorrelated` upstream has 8/10 A-facts **occurring only in the summary**, answering 16/16. When the tight budget stops the summary from copying, the old topic drops to 0–1/16 — **it disappears with the budget, so it can't count as memory either.** And the fork's old-topic retention count is **≤6/10** under `shared` and **0** under `decorrelated`, cell-for-cell matching the §4.6 stub diagnosis: **the §4.6 shared artifact reproduces verbatim on the real-summarizer path**, so the two harnesses corroborate each other.

   Both retention-zone counts come from the two real-LLM JSONs that were **not re-run**, and are **pre-fix marker counts** inflated by at most 2 (§4.10): so the `shared` side is written only as the bound `≤8/10` / `≤6/10` (the true values are at least 6/10 and 4/10, hence never 0), while the `decorrelated` 0 is exact — the bias only ever adds, never subtracts, so the directional claims "shared side is not 0, decorrelated side is 0" survive. The rest of this section (`correct` column, summary-cap counts) does not go through marker matching and is unaffected.

Variance statement matches §4.3: same model sums up and judges, 16 questions/cell, and the gateway can give different results under identical settings. This section only claims the direction under item 2 (**and only for the current topic**); everything else reads as "no measured difference" or a negative, not "improved X points".

### 4.8 Digital audit index (which JSON / protocol / aggregation each X/20 maps to)

The several `X/20` in the text arise from **different conventions**, not contradiction. For review, trace each number to its raw JSON row with this table:

| Number in the text | Protocol | Aggregation | Seeds | Source JSON (row) | Note |
|---|---|---:|---|---|---|
| headline `15.9/20` | `benchmark:holdout` | **mean over 10 held-out seeds** | 20260921–30 (>20260920, never tuned) | `holdout-2026-09-12.json` rows: `shipped default` × en × 160 (mean 15.9, sd 0.32, min 15, max 16) | headline number |
| headline `8.0/20` | same | same | same | same JSON `shipped default` × zh × 160 (mean 8.0) | Chinese headline |
| headline `7.4/20` / `4.0/20` | same | same | same | same JSON `shipped default` × en/zh × 80 | N=80 tier |
| §4.1 `0→6/7/16` | `benchmark` (tune protocol) | **median over tuning seeds** | base 20260911 | `ab-2026-09-12.json` | N=40/80/160 medians; **not the same seed batch** as holdout, hence 16≠15.9 |
| §4.1a "recall 16/20" | `benchmark:extraction` | **median over 3 held-out seeds** | 20260921–23 (SEEDS=3) | `extraction-precision-2026-09-12.json` | measures only precision/recall, not the main benchmark |
| §4.2 tuning grid `63/120` (nine-way tie; current default `60/120`) | `benchmark:tune` | **median over tuning seeds** | 20260911–13 (N=80 × 2 langs) | `tune-2026-09-12.json`, `ranking[]` | unit is "facts per language pair out of 120", not `X/20`; the pre-fix `72/120` was inflated and is superseded (§4.10) |
| `pnpm benchmark:demo` live `16/20` | single run | **single run** | 20260911 (**tuning seed**, not holdout) | terminal output | demo single line, not the headline number; was `18/20` pre-fix |
| §4.9 long-horizon table | `benchmark:long-horizon` | **mean of the final state over 80 seeds** | 20261021–20261100 (disjoint from tune, holdout and spot-check seeds) | `long-horizon-carryover-{on,off}-2026-09-12.json`, `finalByBracket[]` | unit is "facts / 5", not `X/20`; the file's `carryOverMode` field says which arm it is |

Two notes:
1. **How finely numbers reconcile**: each JSON is a resettable on-disk output; `holdout`'s `max=16` exactly covers the demo's `16/20` (that is one sample within the same seed range), not a contradiction.
2. **Why several aggregations**: holdout is "never use tuned seeds + mean" to answer "robustness"; tune is "median over seen seeds" to answer "shape". Both use the same verbatim-reproduction metric but differ in seed set, aggregation and grid size (holdout: 20 facts per cell; tune: 120 cells per language pair) — all stated, all auditable.

---

### 4.9 Long horizon: one task across several compactions (`benchmark:long-horizon`)

Every protocol above measures **one** compaction. A real long session does not: a task runs to the context limit, gets compacted, keeps running, gets compacted again. `benchmarks/longHorizon.ts` measures that — one continuing task compacted 3 times in a row, where **round r's input is round r−1's actual output** (`buildPostCompactMessages(result)` + a new phase), not a re-simulation. Facts are injected in three brackets: before round 1 (oldest), before round 2 (middle), before round 3 (newest), 5 each; after every round we count how many are still verbatim in the post-compaction context.

80 seeds (20261021–20261100, disjoint from every tune, holdout and spot-check seed), final state after round 3 (facts / 5):

| Injected | Upstream | Hippo (carry-over off) | Hippo (default, carry-over on) |
|---|---:|---:|---:|
| Oldest | 0.00 | 0.01 | 0.00 |
| Middle | 0.00 | 1.36 | **1.80** |
| Newest | 1.00 | 5.00 | 4.97 |
| Total / 15 | 1.00 | 6.38 | **6.78** |

Paired per seed (carry-over on vs off, 80 pairs): middle 27 W / 53 T / 0 L, total 25 / 54 / 1, both two-sided exact sign test p < 1e-4; newest 0 / 78 / 2 (p = 0.5 — 2 seeds of 80 lose one fact).

> **This table was corrected once.** The oldest row used to read upstream 1.00 / off 1.01 / on 1.00. That was a phantom produced by our own fact-marker matching: a prefix collision, where `FACT1` also matched `FACT10`–`FACT19` (see [§4.10](#410-measurement-fix-a-prefix-collision-between-fact-markers) below and `benchmarks/factPresent.ts`). With that fixed the row collapses to zero; the middle and newest rows are bit-identical and so are all paired counts.

Three caveats that belong with the table:

1. **The oldest bracket ends at essentially zero on both sides.** Rescuing it was the point of carry-over and it **failed** (0.01 → 0.00, 79 ties and 1 loss). The mechanism is in `src/context/compaction/retention/CarryOver.ts`: the allowance is handed out best-current-score first, and the oldest messages have the lowest similarity *and* the lowest recency, so the allowance is consumed by the middle bracket carried from the previous round. Filling it oldest-first instead gives oldest 2.01 / middle 0.45 / newest 4.80 / total 7.26 — it trades brackets rather than fixing them and lands below the off arm, so it was not taken. **Both rejected designs (flat bonus, oldest-first) are recorded in the code comment with their measured numbers**, not just dismissed in prose.
2. **The summariser is a fixed-text stub** that never emits a fact marker, so "summary-only" is 0 by construction and "survives nowhere" equals "not verbatim". A real summariser can preserve a fact in prose, so this column **over-states** what a real model loses; the real-summariser long-horizon record is §4.7 and `benchmark:real-llm-topic-switch`.
3. **Result files**: `benchmarks/results/long-horizon-carryover-on-2026-09-12.json` and `...-off-...json` — the filename does not name the arm, the `carryOverMode` field inside does (`on (shipped default)` / `off`). Reproduce with `corepack pnpm benchmark:long-horizon`; `PILOTDECK_CARRYOVER=off` for the control arm; `PILOTDECK_LONG_HORIZON_SEEDS` / `--rounds` change the seed and round counts; every run writes a fresh timestamped JSON. The table above is aggregated straight from those files' `raw[]` (each seed's `rounds[-1].byBracket`), and **rounding is worth watching**: `finalByBracket[].hippoVerbatim` is the script's own two-decimal **truncation**, which is why the newest bracket reads `4.97` there while the raw mean is `4.975` — every document here writes `4.97`, matching what the JSON prints. Likewise the total column is the sum of the three raw means (`6.375` / `6.775`) and can differ by 0.01 from adding the rounded rows. To check a digit, aggregate `raw[]`, not `finalByBracket[]`.

### 4.10 Measurement fix: a prefix collision between fact markers

Synthetic facts are marked `FACT1` … `FACT20`, and every counting script used `text.includes(marker)` to decide whether a fact had survived. But `"FACT1"` is a prefix of `"FACT10"`–`"FACT19"`, and `"FACT2"` is a prefix of `"FACT20"` — so **a different fact that happened to be retained was counted as this one**.

That is not hypothetical. On the demo case (seed 20260911, N=160) the post-compaction context contained the substring `FACT1` **ten times** and the literal `FACT1:` **zero** times; `FACT2` was the same, every hit coming from `FACT20`. Every "how many facts are still verbatim" count in the repository carried that bias.

- **Fix**: `benchmarks/factPresent.ts` matches **whole markers** only — after a hit it checks that the next character is not a digit, and keeps searching otherwise. Every benchmark script now reads through it, so the bias cannot come back one script at a time.
- **Reach** (each cell re-measured): most cells move by ~0.01; the long-horizon foundation bracket drops **1.00 → 0.00** (§4.9), and the demo case goes 18/20 → 16/20 (the two phantom hits were `FACT1` and `FACT2`).
- **Not affected**: the real-LLM `correct` column comes from `gradeView(judge.text, view)` — a strict label match on the model's answer — and never goes through marker matching. The `markerInBody` / `markerInSummaryOnly` columns in those files are affected. Every stub-based script under `benchmarks/` was re-measured, but the two real-LLM `real-llm-topic-switch-*.json` files were **not** re-run — that would spend competition API quota, and every conclusion in §4.7 rests on the `correct` column, not on markers. The retention-zone counts quoted from those files have therefore been restated as upper bounds (§4.7, item 3): the bias only ever **adds**, never subtracts, so the two directional claims — "decorrelated side is exactly 0" and "shared side is not" — survive it.
- **Reproduce**: the pre-fix JSONs remain in git history; `git log -p benchmarks/factPresent.ts` and the new JSONs behind each table here reconcile cell by cell.
