import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runEngine } from "./engineRunner.js";
import { TokenBudgetManager } from "../src/context/budget/TokenBudgetManager.js";
import { messageVisibleText } from "../src/context/compaction/retention/MessageText.js";
import {
  buildEbbinghausPageRankPolicy,
  EBBINGHAUS_DEFAULT_WEIGHTS,
} from "../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import {
  generateTranscript,
  generateZhTranscript,
  type SyntheticTranscript,
} from "./syntheticTranscript.js";

// Held-out seed validation.
//
// `tune.ts` selects the default weights on seeds 20260911..20260913 and
// `ablation.ts` reports component contributions on 20260911..20260920. Both
// ranges are *seen*: a weight chosen by looking at them can overfit them. This
// script re-runs the same comparison on seeds 20260921..20260930, which no
// selection step has ever touched, and reports it the honest way:
//
//   * per-seed paired deltas (each seed is its own control), not just means;
//   * a sign test (wins/losses/ties), which needs no distributional assumption;
//   * mean +/- sample sd so the reader can see the spread the mean hides.
//
// Metric is "bytes retained": how many of the 20 injected FACT markers survive
// into the post-compaction context. It measures retention/recall of the
// context, NOT answer quality — see benchmarks/realLlmEval.ts for that.
//
// `PILOTDECK_HOLDOUT_SEED_BASE` lets a reviewer re-run the whole comparison on
// any fresh seed base of their own choosing (e.g. to check the result isn't an
// artifact of this particular seed range). Default stays 20260921.

const HOLDOUT_SEED_BASE = Number(process.env.PILOTDECK_HOLDOUT_SEED_BASE ?? "20260921");
const SEEDS = 10;
const NUM_PAIRS = [80, 160] as const;

// Seeds already used by tune.ts / ablation.ts. Guard against silently
// re-introducing them into the holdout set.
const SEEN_SEED_MAX = 20260920;

type Variant = {
  key: string;
  /** undefined = no retention policy at all (upstream path). */
  weights?: { wSim: number; wTime: number; wRank: number };
  idfCorrection?: boolean;
};

const VARIANTS: Variant[] = [
  { key: "upstream (no retention)" },
  { key: "old default 0.4/0.35/0.25", weights: { wSim: 0.4, wTime: 0.35, wRank: 0.25 }, idfCorrection: true },
  {
    // Comes from EBBINGHAUS_DEFAULT_WEIGHTS, so this row always re-tests
    // whatever the code currently ships rather than a copy that can drift.
    key: "shipped default",
    weights: {
      wSim: EBBINGHAUS_DEFAULT_WEIGHTS.wSim,
      wTime: EBBINGHAUS_DEFAULT_WEIGHTS.wTime,
      wRank: EBBINGHAUS_DEFAULT_WEIGHTS.wRank,
    },
    idfCorrection: true,
  },
  { key: "previous default 0.7/0.15/0.15", weights: { wSim: 0.7, wTime: 0.15, wRank: 0.15 }, idfCorrection: true },
  { key: "sim only", weights: { wSim: 1, wTime: 0, wRank: 0 } },
  { key: "rank only (raw)", weights: { wSim: 0, wTime: 0, wRank: 1 }, idfCorrection: false },
  { key: "rank only (+idf)", weights: { wSim: 0, wTime: 0, wRank: 1 }, idfCorrection: true },
];

function countFacts(transcript: SyntheticTranscript, text: string): number {
  return transcript.facts.filter((fact) => text.includes(fact.marker)).length;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleSd(values: number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mu) ** 2, 0) / (values.length - 1));
}

/** Two-sided sign test p-value; ties are dropped (conservative for small n). */
function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  // P(X <= min) * 2 under Binomial(n, 0.5), computed exactly.
  const k = Math.min(wins, losses);
  let tail = 0;
  let binom = 1; // C(n, 0)
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) binom = (binom * (n - i + 1)) / i;
    tail += binom * 0.5 ** n;
  }
  return Math.min(1, 2 * tail);
}

async function scoreCell(
  transcript: SyntheticTranscript,
  variant: Variant,
): Promise<{ facts: number; postTokens: number; wallMs: number }> {
  const policy = variant.weights
    ? buildEbbinghausPageRankPolicy({
        wSim: variant.weights.wSim,
        wTime: variant.weights.wTime,
        wRank: variant.weights.wRank,
        idfCorrection: variant.idfCorrection,
      })
    : undefined;
  const start = performance.now();
  const run = await runEngine(transcript.messages, policy ? "hippo" : "upstream", policy);
  return {
    facts: countFacts(transcript, run.fingerprint),
    postTokens: run.postTokens,
    wallMs: performance.now() - start,
  };
}

async function main() {
  if (HOLDOUT_SEED_BASE <= SEEN_SEED_MAX) {
    throw new Error(
      `holdout seeds must start after ${SEEN_SEED_MAX}; tune.ts/ablation.ts already used up to that seed`,
    );
  }

  const seeds = Array.from({ length: SEEDS }, (_, offset) => HOLDOUT_SEED_BASE + offset);
  console.log(
    `held-out seeds ${seeds[0]}..${seeds[SEEDS - 1]} (n=${SEEDS}), N=${NUM_PAIRS.join("/")}, ` +
      `variants=${VARIANTS.length}, facts/case=20\n`,
  );

  type Cell = { lang: "en" | "zh"; numPairs: number; variant: string; perSeed: number[]; tokens: number[]; wallMs: number[] };
  const cells: Cell[] = [];

  for (const lang of ["en", "zh"] as const) {
    for (const numPairs of NUM_PAIRS) {
      // Build the transcripts once so every variant sees byte-identical input.
      const transcripts = seeds.map((seed) =>
        lang === "en" ? generateTranscript({ numPairs, seed }) : generateZhTranscript({ numPairs, seed }),
      );
      for (const variant of VARIANTS) {
        const perSeed: number[] = [];
        const tokens: number[] = [];
        const wallMs: number[] = [];
        for (const transcript of transcripts) {
          const scored = await scoreCell(transcript, variant);
          perSeed.push(scored.facts);
          tokens.push(scored.postTokens);
          wallMs.push(scored.wallMs);
        }
        cells.push({ lang, numPairs, variant: variant.key, perSeed, tokens, wallMs });
      }
    }
  }

  const cellFor = (lang: "en" | "zh", numPairs: number, variant: string) =>
    cells.find((cell) => cell.lang === lang && cell.numPairs === numPairs && cell.variant === variant)!;

  // ---- Table 1: level per variant, on unseen seeds -------------------------
  console.log("### Level on held-out seeds (facts retained / 20)\n");
  console.log("| lang | N | variant | mean | sd | min | max | post tokens (mean) | wall ms (mean) |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  const rows: Array<Record<string, unknown>> = [];
  for (const cell of cells) {
    const row = {
      lang: cell.lang,
      numPairs: cell.numPairs,
      variant: cell.variant,
      n: cell.perSeed.length,
      mean: Math.round(mean(cell.perSeed) * 100) / 100,
      sd: Math.round(sampleSd(cell.perSeed) * 100) / 100,
      min: Math.min(...cell.perSeed),
      max: Math.max(...cell.perSeed),
      postTokensMean: Math.round(mean(cell.tokens)),
      wallMsMean: Math.round(mean(cell.wallMs) * 10) / 10,
    };
    rows.push(row);
    console.log(
      `| ${row.lang} | ${row.numPairs} | ${row.variant} | ${row.mean} | ${row.sd} | ${row.min} | ${row.max} | ${row.postTokensMean} | ${row.wallMsMean} |`,
    );
  }

  // ---- Table 2: paired comparisons on the same seeds -----------------------
  const comparisons: Array<Record<string, unknown>> = [];
  console.log("\n### Paired per-seed comparisons (same seed = its own control)\n");
  console.log("| lang | N | A vs B | mean delta (A-B) | wins A | ties | wins B | sign-test p |");
  console.log("|---|---|---|---|---|---|---|---|");
  const pairs: Array<[string, string]> = [
    ["shipped default", "upstream (no retention)"],
    ["old default 0.4/0.35/0.25", "upstream (no retention)"],
    ["shipped default", "previous default 0.7/0.15/0.15"],
    ["shipped default", "old default 0.4/0.35/0.25"],
    ["rank only (+idf)", "rank only (raw)"],
  ];
  for (const lang of ["en", "zh"] as const) {
    for (const numPairs of NUM_PAIRS) {
      for (const [keyA, keyB] of pairs) {
        const a = cellFor(lang, numPairs, keyA);
        const b = cellFor(lang, numPairs, keyB);
        const deltas = a.perSeed.map((value, index) => value - b.perSeed[index]!);
        const wins = deltas.filter((delta) => delta > 0).length;
        const losses = deltas.filter((delta) => delta < 0).length;
        const ties = deltas.filter((delta) => delta === 0).length;
        const p = signTestP(wins, losses);
        const record = {
          lang,
          numPairs,
          a: keyA,
          b: keyB,
          meanDelta: Math.round(mean(deltas) * 100) / 100,
          winsA: wins,
          ties,
          winsB: losses,
          signTestP: Math.round(p * 1000) / 1000,
        };
        comparisons.push(record);
        console.log(
          `| ${lang} | ${numPairs} | ${keyA} vs ${keyB} | ${record.meanDelta} | ${wins} | ${ties} | ${losses} | ${record.signTestP} |`,
        );
      }
    }
  }

  // ---- Table 3: no-query probe on held-out seeds --------------------------
  // The level/paired tables above always have a pending user request, so the
  // similarity term carries the signal and the rank term looks inert. This
  // probe removes the query (queryHint="") — the regime where sim is flat —
  // to test out-of-sample whether IDF-weighted PageRank picks up anything.
  // Reported separately because it answers a different question.
  console.log("\n### No-query probe on held-out seeds (queryHint='', budget=520)\n");
  console.log("| lang | N | variant | facts retained (mean / max possible) |");
  console.log("|---|---|---|---|");
  const noQuery: Array<Record<string, unknown>> = [];
  const probeVariants = VARIANTS.filter((variant) => variant.weights);
  for (const lang of ["en", "zh"] as const) {
    for (const numPairs of NUM_PAIRS) {
      const transcripts = seeds.map((seed) =>
        lang === "en" ? generateTranscript({ numPairs, seed }) : generateZhTranscript({ numPairs, seed }),
      );
      for (const variant of probeVariants) {
        const policy = buildEbbinghausPageRankPolicy({
          wSim: variant.weights!.wSim,
          wTime: variant.weights!.wTime,
          wRank: variant.weights!.wRank,
          idfCorrection: variant.idfCorrection,
        });
        let total = 0;
        for (const transcript of transcripts) {
          const retained = await policy.pickRetained({
            candidates: transcript.messages.slice(0, -2),
            retentionBudgetTokens: 520,
            queryHint: "",
            estimateTokens: (messages) => new TokenBudgetManager().estimateMessagesTokens(messages),
          });
          total += countFacts(transcript, retained.map(messageVisibleText).join("\n"));
        }
        const possible = transcripts.length * 20;
        noQuery.push({
          lang,
          numPairs,
          variant: variant.key,
          factsTotal: total,
          possible,
          mean: Math.round((total / transcripts.length) * 100) / 100,
        });
        console.log(`| ${lang} | ${numPairs} | ${variant.key} | ${(total / transcripts.length).toFixed(2)} / 20 |`);
      }
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    protocol: "benchmarks/holdout.ts",
    timestamp,
    holdoutSeedBase: HOLDOUT_SEED_BASE,
    seenSeedMax: SEEN_SEED_MAX,
    seeds,
    numPairs: NUM_PAIRS,
    factsPerCase: 20,
    metric: "facts retained in post-compaction context (recall proxy; not answer quality)",
    variants: VARIANTS,
    rows,
    comparisons,
    noQueryProbe: noQuery,
  };
  const resultsDir = resolve(join(process.cwd(), "benchmarks", "results"));
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = resolve(resultsDir, `holdout-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log("\nresults written:", outputPath);
}

void main();
