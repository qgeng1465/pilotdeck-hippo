# Superseded results (pre-measurement-fix)

Everything in this directory was produced **before** the fact-marker prefix
collision was fixed in `benchmarks/factPresent.ts` (see
[docs/evaluation.md §4.10](../../../docs/evaluation.md)). Because the old
matcher counted `FACT1` as present whenever `FACT10`–`FACT19` was, and `FACT2`
whenever `FACT20` was, every "facts still verbatim" column in here is inflated.
The bias is bounded by 2 — only `FACT1` and `FACT2` can collide — and for the
cells that retain facts it lands at exactly 2: every shipped-default cell in the
holdout, spot-check, ablation and A/B tables reads 2 higher here than in the
current files. Arms that retain almost nothing move less (e.g. `time only`
zh N=40: 4 → 2). The long-horizon foundation bracket reads 1.00 higher.

They are kept for auditability (a reviewer can re-derive the correction), not
because any figure in them should be quoted. The current files live one
directory up. Real-LLM result files are **not** here and were not affected: their
`correct` column comes from `gradeView(...)`, a strict label match on the model's
answer, which never goes through marker matching.
