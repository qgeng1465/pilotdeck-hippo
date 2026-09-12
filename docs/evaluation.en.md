# Benchmark Protocol and Results (full record)

This is the full record behind the numbers in the main README: protocols, tables, sensitivity analysis and honest boundaries, all kept verbatim.
Every figure traces to a committed `benchmarks/results/*.json`, reconcilable row by row via the audit index at the end.
The main README keeps only the overview; this file is its expansion — back to [../README.md](../README.md).

## 4. Benchmark Approaches and Results

### 4.1 Structural stress test (fake summarizer)

Synthetic bioinformatics dialogues scatter 20 precise facts across the first ~75% of messages; the tail asks for verbatim reproduction. The fake summarizer never emits FACT text, so upstream 0/20 is a *structural* contrast ("lossy summary vs verbatim retention"), not a ceiling on what a real summarizer can do. The table below is the **median** produced by `pnpm benchmark` (seed=20260911), from `benchmarks/results/2026-09-11T11-16-22-522Z.json`:

| N | Pre-compaction tokens | Upstream post | Hippo post | Fact retention /20 (upstream → Hippo) |
|---:|---:|---:|---:|---:|
| 40 | 3,906 | 1,153 | 1,381 | 0 → 8 |
| 80 | 8,291 | 2,368 | 2,634 | 0 → 9 |
| 160 | 17,034 | 4,739 | 5,339 | 0 → 18 |

I.e. Hippo trades ~1.11–1.20× post-compaction tokens for verbatim facts; every run is deterministic (`true`). **The cost is stated plainly**: this 11–20% is extra, not saved — Hippo buys "facts still reproducibly verbatim after compaction", not "compresses harder".

### 4.1a Extraction precision (per-message precision/recall): the direct answer to "how do you guarantee accurate extraction"

The `0/20→8/9/18` above is **recall** — how many of the 20 facts the query must reproduce survive; it does not say whether the retention block is mostly the right messages. This section measures precision/recall at message granularity from the engine's own `retention.retainedMessageTexts` (the messages scoring selected and actually entering the post-compaction context, **not reconstructed from the fingerprint — no reconstruction artifacts**), on held-out seeds (2026-09-21+) via `pnpm benchmark:extraction` (JSON: `benchmarks/results/extraction-precision-2026-09-11T13-39-26-139Z.json`):

| lang | N | Recall (fraction kept) | Precision (relevant share of retained block) | Random baseline | Lift over random |
|---|---:|---:|---:|---:|---:|
| en | 40 | 6/20 | **100%** | 36% | 2.8× |
| en | 80 | 7/20 | **100%** | 18% | 5.7× |
| en | 160 | 16/20 | **100%** | 9% | 11× |
| zh | 40 | 4/20 | **100%** | 37% | 2.7× |
| zh | 80 | 4/20 | **100%** | 18% | 5.6× |
| zh | 160 | 8/20 | **89%** | 9% | 10× |

(Recall differs slightly from §4.1: that is the seed-20260911 tuning protocol; this is held-out seeds, counted by "messages" rather than "markers"; both are within-budget recall.)

1. **High precision = the scoring really separates signal from noise**: the retained block is almost entirely fact messages the current query needs (only zh N=160 sneaks in one noise message), 2.7–11× over random — it is not dumping the whole history back in.
2. **Recall is bounded by the token budget**: the retention budget (≤256 tok, actually using 88–99%) only fits 4–16 messages. **The cost is explicit**: keep the most relevant, can't hold everything — the same trade-off as the main benchmark's "pay tokens for fidelity" (1.11–1.20×).
3. **What it guarantees**: this does not guarantee correct selection on arbitrary real tasks — the scorer is still an unsupervised heuristic. What it *does* guarantee are the two measurable things — **once selected, almost necessarily relevant (precision) and verbatim-lossless (per §4.1); the costs and boundaries are written in the table**.

### 4.2 Component ablation

Splitting the same formula apart, re-run on identical transcripts (protocol: EN+ZH, N=40/80/160, 10 seeds; medians. From `benchmarks/results/ablation-2026-09-11T11-17-30-040Z.json`):

| Variant | EN N=160 | EN N=80 | ZH N=160 | ZH N=80 |
|---|---:|---:|---:|---:|
| sim only | 16 | 7 | 8 | 4 |
| time only | 2 | 2 | 2 | 2 |
| rank only (raw PageRank) | 0 | 0 | 0 | 0 |
| rank only (+IDF) | 0 | 0 | 1.5 | 1 |
| full (old default 0.4/0.35/0.25) | 10.5 | 6.5 | 6 | 5 |
| **full (current default 0.85/0.15/0.00)** | **18** | **9** | **10** | **6** |

(Medians under the tuning protocol. The `0.7/0.15/0.15` variant is not listed here — its difference from the current default is tested by a *hold-out* paired comparison, §4.5 row 4 and item 3 below; the two protocols' numbers are not mixed.)

Ablation surfaced and fixed three problems on the spot:

1. **Hub dilution**: the hubs of raw PageRank are repeated noise (QC, Step, and other tokens appearing in every message); the fact messages' unique entities score low — rank alone scores 0. After IDF correction the Chinese rank term recovers signal (ZH N=40: 0 → 3.5).
2. **Weight mismatch**: the old default let time/rank dilute the main `sim` term. `pnpm benchmark:tune` re-anchored over an 18-config grid (N=80 × 3 seeds × 2 langs); the current default **ranks first at 72/120**, and is first in all 6 `(lang × N)` cells. (The §4.2 table lists only 4 cells for layout; the full 6 including N=40 are in the ablation JSON.)
3. **The default was not the optimum** (found by the hold-out re-check): the grid's **argmax is `0.85/0.15/0.00` (72/120), but the code constant at the time was `0.7/0.15/0.15` (68/120)** — the default deviated from the tuning result itself. On never-tuned seeds 20260921–20260930, one-to-one paired comparison (§4.5), the rank term is **7 wins / 33 ties / 0 losses, no cell significant** (p = 1 / 0.5 / 1 / 0.125).

   **How it was fixed**: set `EBBINGHAUS_DEFAULT_WEIGHTS` to `{0.85, 0.15, 0}`, aligned with the tuning argmax; the rank term is **not deleted**, its weight just goes to 0, and the formula, entity-graph code and the `wRank` config all remain, re-enable with one line of config. Plus a mechanical guard: in `holdout.ts` the "current default" row reads the `EBBINGHAUS_DEFAULT_WEIGHTS` constant directly instead of a copied literal, so **any future default drift shows up directly in the hold-out table**.

   **Honest boundary**: we changed weights but **do not claim an improvement**. rank's 0 losses on holdout only say "dropping it costs nothing"; 7-33 means the effect is far smaller than the noise — the real justification is that it aligns with the tuning argmax and is simpler (three terms → two), not that it scores more. The contrast vs upstream (no retention) — 17.9 / 9.4 / 10.0 / 6.0 — is this work's main effect: all four cells 10 wins 0 ties 0 losses, p=0.002.

4. **Retention degenerates without a query** (newly found and fixed this round): compaction isn't always triggered by a new user request — one very long tool output blowing the budget triggers it too. Then there is no user message in the tail window, `queryHint` degenerates to an empty string, and the similarity term goes to zero: the hold-out no-query probe shows the current default keeps only **0.00–0.20 / 20** facts, while pure `sim` can keep 1–2. This is not a weighting problem — putting the rank weight back doesn't rescue the main path (see above).

   **How it was fixed**: fix the cause, not the weight. `CompactionEngine` now, when the tail yields no real user request, falls back to the **most recent real user request in the whole conversation** (still the request that the compacted messages serve), rather than an empty string. The regression test `tests/context/hippo-retention.spec.ts` "retention is still query-conditioned when the tail holds no user request" fails deterministically when the fix is reverted (the policy receives `""` in practice) and passes with it. Incidentally this reveals where the rank term genuinely has signal: precisely in the no-query regime (Chinese no-query probe: rank+IDF 2.8/20 vs sim-only 1.0/20; English 0–0.5/20) — but that regime is now eliminated at the engine level.

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

Policy scoring is local computation, median latency: EN ≈ 13–50 ms, ZH ≈ 135–369 ms (measured extremes of `wallMsMedian` in the ablation JSON, N=40→160; Chinese bigram entity counts run ~5–10× English, so a bigger graph). Compared with one real LLM summary call (seconds), scoring overhead is ≈5–15%, and compaction is a low-frequency event. Optimization paths (per-message entity truncation, fewer PageRank iterations) are already parameterized. Measure: `pnpm benchmark:ablation` (wall ms column); machine specifics in the result JSON.

### 4.5 Holdout validation (seeds used for parameter selection are never used)

The §4.2 tables pick weights on a seed batch and then report scores on that same batch — that only shows "fits well", nothing else. This section separates the two concerns:

- **Protocol**: `SEEN_SEED_MAX = 20260920`, `HOLDOUT_SEED_BASE = 20260921`. Tuning/ablation uses only seeds ≤ 20260920; the holdout set always takes seeds 20260921–20260930 (10 seeds), **never used in any selection** (weights, IDF switch, PageRank iteration count included).
- **Statistics**: each seed is paired with itself (same seed, same transcript, only the strategy changes); we report per-seed deltas, win/tie/loss and a **two-sided exact sign-test p**. With 10 seeds the smallest possible sign-test p is 0.002, so p=0.002 means "won all 10", not "huge effect size".
- **Verifiable**: `pnpm benchmark:holdout`; the table here is from `benchmarks/results/holdout-2026-09-11T11-19-13-567Z.json` (the directory keeps several earlier runs from the same day; this file is the one §4.5 cites).

Holdout table by variant (mean / 20 facts, 10 seeds):

| lang | N | Variant | Retained | sd | min | max | Post-compaction tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| en | 80 | upstream (no retention) | 0 | 0 | 0 | 0 | 2,362 |
| en | 80 | old default 0.4/0.35/0.25 | 6.6 | 1.35 | 5 | 9 | 2,641 |
| en | 80 | **current default 0.85/0.15/0.00** | **9.4** | 0.52 | 9 | 10 | 2,641 |
| en | 160 | upstream (no retention) | 0 | 0 | 0 | 0 | 4,753 |
| en | 160 | old default 0.4/0.35/0.25 | 10.8 | 0.63 | 10 | 12 | 5,349 |
| en | 160 | **current default 0.85/0.15/0.00** | **17.9** | 0.32 | 17 | 18 | 5,355 |
| zh | 80 | upstream (no retention) | 0 | 0 | 0 | 0 | 2,148 |
| zh | 80 | old default 0.4/0.35/0.25 | 5.1 | 0.57 | 4 | 6 | 2,394 |
| zh | 80 | **current default 0.85/0.15/0.00** | **6.0** | 0 | 6 | 6 | 2,392 |
| zh | 160 | upstream (no retention) | 0 | 0 | 0 | 0 | 4,088 |
| zh | 160 | old default 0.4/0.35/0.25 | 5.9 | 0.57 | 5 | 7 | 4,604 |
| zh | 160 | **current default 0.85/0.15/0.00** | **10.0** | 0 | 10 | 10 | 4,610 |

Paired comparisons (each seed as its own control):

| Comparison | en N=80 | en N=160 | zh N=80 | zh N=160 |
|---|---:|---:|---:|---:|
| current default vs upstream | +9.4 (10/0/0, p=.002) | +17.9 (10/0/0, p=.002) | +6.0 (10/0/0, p=.002) | +10.0 (10/0/0, p=.002) |
| old default vs upstream | +6.6 (10/0/0, p=.002) | +10.8 (10/0/0, p=.002) | +5.1 (10/0/0, p=.002) | +5.9 (10/0/0, p=.002) |
| current default vs old default | +2.8 (9/1/0, p=.004) | +7.1 (10/0/0, p=.002) | +0.9 (8/2/0, p=.008) | +4.1 (10/0/0, p=.002) |
| current vs previous default 0.7/0.15/0.15 | +0.1 (1/9/0, p=1) | +0.2 (2/8/0, p=.5) | 0 (0/10/0, p=1) | +0.5 (4/6/0, p=.125) |

**How to read — and how NOT to read — this table**:

- The main effect is **row one**: no retention → verbatim retention, 10 wins 0 ties 0 losses in all four cells. This is the claim we put out publicly.
- Row three (vs old default 0.4/0.35/0.25) is also solid, winning all four EN+ZH cells — the old default gave 0.25 to the rank term, letting rank dilute `sim`; that was the real weight mismatch.
- **Row four must be read as "no difference"**: 7 wins 33 ties 0 losses, p = 1 / 0.5 / 1 / 0.125, none significant. The legitimate reason to move the default weight to 0.85/0.15/0.00 is "align with the tuning argmax + one fewer term", **not** "it improved the score". Any claim that "weight tuning brought a significant improvement" contradicts this table.
- zh N=80 / zh N=160 have sd = 0 (all 10 seeds identical). This is not high precision; in the Chinese cells the retained messages concentrate on the same few typical facts. When reading Chinese numbers, look at the overall direction across the 10 seeds, not decimal-place differences.

### 4.6 Topic switching: how much of an old topic survives

The transcripts in earlier sections run "one topic all the way". Real use more often means **switching topics mid-way**: the first half is topic A, the tail starts asking about B, and at compaction only B's request is in hand. Then A-segment messages get **no query relevance for their own topic** — they can only compete for the leftover budget through residual similarity.

Protocol: 10 hold-out seeds, 10 facts per topic (20 total), A then B, and the pending request at compaction is B's. Script `pnpm benchmark:topic-switch`, table from `benchmarks/results/topic-switch-2026-09-11T11-48-15-802Z.json`; mechanism-diagnosis script `pnpm benchmark:topic-diagnosis`, from `benchmarks/results/topic-diagnosis-2026-09-11T11-44-03-797Z.json`.

**This table has two fact phrasings and must be read with both — citing only one half gives a wrong conclusion**:

| N | Fact phrasing | Variant | Topic A verbatim retained | Topic B verbatim retained | Post-compaction tokens |
|---:|---|---|---:|---:|---:|
| 80 | shared | upstream | 0 | 6 | 1,844 |
| 80 | shared | Hippo | 2 | **10** | 2,095 |
| 160 | shared | upstream | 0 | 6 | 3,451 |
| 160 | shared | Hippo | 5.9 | **10** | 3,889 |
| 80 | **decorrelated** | upstream | 0 | 6 | 1,798 |
| 80 | **decorrelated** | Hippo | **0** | **10** | 2,053 |
| 160 | **decorrelated** | upstream | 0 | 6 | 3,398 |
| 160 | **decorrelated** | Hippo | **0** | **10** | 3,827 |

`shared` = the original phrasing: both topics' facts share one field template (`cohort=… n=371 gene=… freq=… stat=…`) and the pending request reuses that vocabulary. `decorrelated` = each topic has its own field words and marker words, and the request only uses B's words, so **topic becomes the only factor distinguishing A from B facts**.

Three readings:

1. **The topic-A column (2 and 5.9 under `shared`) is a harness artifact that collapses to zero under `decorrelated`**. Diagnostic evidence: in single-term ablation `time only` and `rank only` are both **0/10**, `sim only` alone reproduces 5.0/10; surviving facts' mean position in the A segment is 0.58 (no "closer = more kept" tendency), further ruling out recency; and directly measuring BM25, A-facts against the B request score **0.820** while A-segment filler messages score **0.240**; rewriting the same facts as prose without the shared field labels drops them to **0.370** — i.e. (0.820 − 0.370) / (0.820 − 0.240) ≈ **78% of the similarity gap comes from the shared template** (using A-segment filler's 0.240 as the baseline in the denominator). Once this lexical bridge is removed, the A column is **0/10**, matching upstream. **So do not publicly say "Hippo remembered the old topic" — it does not.**
2. **The only conclusion that holds in both directions is in the B column: 6/10 → 10/10**. In the post-compaction context, *current*-topic precise facts are retained verbatim, while upstream under this stub summarizer only gets 6/10. This shares its origin with the §4.1 main effect: **the benefit is fidelity to the current task, not memory of old context.** (Tokens also drop slightly under `decorrelated`, since budget is no longer spent on the A segment.) **But this 6/10 has a stub-summarizer component**: in §4.7, with a real summarizer, upstream's current topic is also all correct, so read the B column as a structural contrast "verbatim retention block vs stub summary", not as "how many more questions the user can answer".
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
3. **The most honest mechanistic statement: the two tight rounds cap the summary almost equally (upstream 3, Hippo 4 / of 4 cases)**, so "upstream is truncated, Hippo isn't" is not the explanation. The explanation is in the retention-zone column: both arms' summaries got cut, **but Hippo additionally has a verbatim retained current-topic checkpoint (8/10 vs upstream's 6/10, tail-only); whether the summary finished writing doesn't affect it. The value of retention shows up when the summarizer can't hold the budget — not when it can.**
4. **The old-topic half is still a negative, and three harnesses corroborate it.** In the generous round, "old topic still answerable" is **the real summarizer transcribing it into its own summary**: both upstream arms have zero retention counts on the old topic (they have no retention block), and under `decorrelated` upstream has 8/10 A-facts **occurring only in the summary**, answering 16/16. When the tight budget stops the summary from copying, the old topic drops to 0–1/16 — **it disappears with the budget, so it can't count as memory either.** And the fork's old-topic retention count is 6/10 under `shared` and **0** under `decorrelated`, cell-for-cell matching the §4.6 stub diagnosis: **the §4.6 shared artifact reproduces verbatim on the real-summarizer path**, so the two harnesses corroborate each other.

Variance statement matches §4.3: same model sums up and judges, 16 questions/cell, and the gateway can give different results under identical settings. This section only claims the direction under item 2 (**and only for the current topic**); everything else reads as "no measured difference" or a negative, not "improved X points".

### 4.8 Digital audit index (which JSON / protocol / aggregation each X/20 maps to)

The several `X/20` in the text arise from **different conventions**, not contradiction. For review, trace each number to its raw JSON row with this table:

| Number in the text | Protocol | Aggregation | Seeds | Source JSON (row) | Note |
|---|---|---:|---|---|---|
| headline `17.9/20` | `benchmark:holdout` | **mean over 10 held-out seeds** | 20260921–30 (>20260920, never tuned) | `holdout-2026-09-11T11-19-13-567Z.json` rows: `shipped default` × en × 160 (mean 17.9, sd 0.32, min 17, max 18) | headline number |
| headline `10.0/20` | same | same | same | same JSON `shipped default` × zh × 160 (mean 10.0) | Chinese headline |
| headline `9.4/20` / `6.0/20` | same | same | same | same JSON `shipped default` × en/zh × 80 | N=80 tier |
| §4.1 `0→8/9/18` | `benchmark` (tune protocol) | **median over tuning seeds** | base 20260911 | `2026-09-11T11-16-22-522Z.json` | N=40/80/160 medians; **not the same seed batch** as holdout, hence 18≠17.9 |
| §4.1a "recall 16/20" | `benchmark:extraction` | **median over 3 held-out seeds** | 20260921–23 (SEEDS=3) | `extraction-precision-2026-09-11T13-39-26-139Z.json` | measures only precision/recall, not the main benchmark |
| `pnpm benchmark:demo` live `18/20` | single run | **single run** | 20260911 (**tuning seed**, not holdout) | terminal output | demo single line, not the headline number |

Two notes:
1. **How finely numbers reconcile**: each JSON is a resettable on-disk output; `holdout`'s `max=18` exactly covers the demo's 18/20 (that is one sample within the same seed range), not a contradiction.
2. **Why two aggregations**: holdout is "never use tuned seeds + mean" to answer "robustness"; tune is "median over seen seeds" to answer "shape". Both use the same metric (how many of 20 facts reproduce verbatim) but differ in seed set and aggregation — all stated, all auditable.
