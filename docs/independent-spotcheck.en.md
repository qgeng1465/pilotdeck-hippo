# Spot-check record: re-running the headline claims on never-used seeds

> **What this is, and what it is not (up front)**: this is a **reproducible spot-check run by the authors**, not a third-party review.
> It answers exactly one question: do the headline numbers in the README still hold on a batch of seeds that has **never** been used for tuning and does **not** appear in any committed JSON (§1, fact retention)? The extraction-precision section (§2) is instead re-measured on the default held-out base after the fix, and is no longer a "different seed" check — see the note in that section for why.
> The scripts are in the repo (`benchmarks/holdout.ts`, `benchmarks/extractionPrecision.ts`; both accept a seed-base override), so anyone can re-run it with one command.
> We include it because "does it survive a different seed?" is the most direct way to falsify "were these numbers cherry-picked?".

- Raw JSON: [`benchmarks/results/spotcheck-seeds20261001-2026-09-12.json`](../benchmarks/results/spotcheck-seeds20261001-2026-09-12.json) (re-measured on 2026-09-12 after the fact-marker prefix collision was fixed; see [the evaluation record §4.10](./evaluation.en.md#410-measurement-fix-a-prefix-collision-between-fact-markers)), [`benchmarks/results/extraction-precision-2026-09-12.json`](../benchmarks/results/extraction-precision-2026-09-12.json) (re-measured after the fix; both old files were moved to `benchmarks/results/superseded-pre-fix/`)
- Seeds already used: `tune.ts` used 20260911–13, `ablation.ts` 20260911–20, the headline holdout 20260921–30.
- **This spot-check's seeds**: holdout **20261001–20261010**, disjoint from all of the above. The extraction section (§2) uses `benchmark:extraction`'s default held-out base **20260921–23** — that metric is only weakly seed-sensitive (see the note in §2), so this section is not a "different seed" re-check, it only confirms the post-fix cells are unchanged.

---

## 1. Fact retention: fresh-seed re-run (`benchmarks/holdout.ts`)

Same "shipped default vs upstream (no retention)", but on seeds 20261001–20261010 (n=10, each seed its own control):

| Setting | Headline (20260921–30) | **This spot-check (20261001–10)** | W/T/L | sign-test p |
|---|---:|---:|---:|---:|
| English N=80 | 7.4 | **7.2** | 10 / 0 / 0 | 0.002 |
| English N=160 | 15.9 | **16.0** | 10 / 0 / 0 | 0.002 |
| Chinese N=80 | 4.0 | **4.0** | 10 / 0 / 0 | 0.002 |
| Chinese N=160 | 8.0 | **8.0** | 10 / 0 / 0 | 0.002 |

(Upstream stays 0 in all four cells on the fresh seeds — "no retention ⇒ 0 verbatim facts" is a structural contrast, independent of seed. Both columns come from the JSONs re-measured after the 2026-09-12 fix; the fix lowers every cell in both columns by 2.0, leaving the paired counts and p-values untouched.)

**Conclusion**: all four means match the headline **in direction, within 0.2**, and **every cell is 10 wins / 0 ties / 0 losses**. The numbers do drift slightly with seed (7.4→7.2, 15.9→16.0), so this is not a hard constant; but the direction and significance reproduce completely.

> Metric caveat (same as the README): this is a **"verbatim-retention recall proxy" under a fake summarizer**, not answer accuracy. Upstream's 0 comes from the fake summarizer not emitting FACT text (a structural design), not from the ceiling of real summarization — see [the evaluation record §4.3](./evaluation.en.md#43-real-llm-closed-loop-two-rounds-with-sensitivity) for the real-QA comparison.

## 2. Extraction precision: post-fix re-measure (`benchmarks/extractionPrecision.ts`)

On `benchmark:extraction`'s default held-out base **20260921–23** (3 seeds), message-level precision:

| Setting | Precision | Recall (median) | vs chance |
|---|---:|---:|---:|
| en N=40 | 100.0% | 30.0% | 2.8× |
| en N=80 | 100.0% | 35.0% | 5.7× |
| en N=160 | 100.0% | 80.0% | 11.1× |
| zh N=40 | 100.0% | 20.0% | 2.7× |
| zh N=80 | 100.0% | 20.0% | 5.6× |
| zh N=160 | 88.9% | 40.0% | 10.0× |

**Conclusion**: six cells, precision ∈ [88.9%, 100%], lift ∈ [2.7×, 11.1×], matching the headline (89–100%, 2.7–11.1×) cell by cell. The only movement is en N=160's lift in its last digit, 11.0× → 11.1×, from the chance baseline going 0.091 → 0.090 — nothing to do with recall or precision.

**Honest note**: this table is **identical cell-by-cell** before and after the fix (bar en N=160's lift in its last digit) — not a coincidence and not us smoothing anything: on the synthetic transcript's fixed fact placement the metric is strongly structural and only weakly seed-sensitive. So this section demonstrates **reproducibility/determinism**, **not** the stronger claim "precision is robust to seed". The seed-sensitive — and therefore more convincing — reproduction is the holdout in §1.

## 3. Reconciliation table: headline number → exact committed JSON row

If you want to know where 15.9 and 89–100% actually live, open these:

| Number | File | Field |
|---|---|---|
| Facts retained 15.9 / 20 (en160, 10 seeds, p=0.002) | `benchmarks/results/holdout-2026-09-12.json` | `rows[]` where `variant="shipped default"`, `lang="en"`, `numPairs=160`: `mean`; paired row in `comparisons[]` (`a="shipped default"`, `b="upstream (no retention)"`, `winsA=10, winsB=0, signTestP=0.002`) |
| Chinese 8.0 / 20, en80 7.4, zh80 4.0 | same file | as above, changing `lang` / `numPairs` |
| Precision 89–100%, 2.7–11.1× | `benchmarks/results/extraction-precision-2026-09-12.json` | per row: `precisionMedian`, `liftOverChance`; recall `recallMedian` |

Reproduce (numbers should match cell-by-cell):

```bash
pnpm benchmark:holdout        # default seeds 20260921–30, writes benchmarks/results/holdout-*.json
pnpm benchmark:extraction     # default seed base 20260921
```

## 4. Re-run it yourself on any seed

Both scripts accept a seed-base override (defaults unchanged):

```bash
PILOTDECK_HOLDOUT_SEED_BASE=20270101 pnpm benchmark:holdout
PILOTDECK_EVAL_SEED_BASE=20270101 PILOTDECK_EVAL_SEEDS=5 pnpm benchmark:extraction
```

(The holdout script guards that its seeds start after `20260920`, so a seen seed cannot silently re-enter the holdout set.)

## 5. What this record does **not** claim

- **Not a third-party review** — authors' own run; it only tests "does it survive a seed change", and does not replace a real QA evaluation.
- Still **synthetic, templated facts** (fake summarizer); still short of real long-conversation noise and topic drift.
- The identical cells in §2 **do not** mean precision is seed-robust (see that section).
- The known biases of the real-LLM closed loop (judge = summarizer model, 16 questions × 2 seeds per cell) are **not** removed by this spot-check and remain as stated in [the evaluation record §4.3](./evaluation.en.md#43-real-llm-closed-loop-two-rounds-with-sensitivity).
