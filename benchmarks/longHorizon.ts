import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runEngine, type EngineVariant } from "./engineRunner.js";
import { messageVisibleText } from "../src/context/compaction/retention/MessageText.js";
import { isCarryOverEnabled } from "../src/context/compaction/retention/CarryOver.js";
import type { CanonicalMessage } from "../src/model/index.js";

// Long-horizon retention: what survives when ONE task is compacted N times in a row?
//
// Every other benchmark in this directory measures a single compaction pass
// (`abHarness.ts`, `holdout.ts`) or two topics across a switch
// (`topicSwitch.ts`). A real long agent session is neither: it is one
// continuous task that runs past the context limit, gets compacted, keeps
// going, and gets compacted again. Each pass consumes the *output* of the
// previous one -- `buildPostCompactMessages(result)` becomes the head of the
// next pass's input -- so a fact that survives pass 1 only gets another chance
// to be dropped by pass 2. That carry-over is the thing this harness measures,
// and it cannot be simulated by re-running single passes: the second input has
// to be the actual first output.
//
// Structure of one case:
//
//   phase 1 (facts bracket 1)  -> compaction round 1 -> phase 2 (bracket 2)
//     -> round 2 -> phase 3 (bracket 3) -> round 3 -> measure
//
// Bracket 1 is the *early foundational* fact (the kind a long task must never
// lose), the last bracket is the *recent* fact, and anything between is *mid*.
// After every round we count how many fact markers are still present
// *verbatim* in the post-compaction prompt, per bracket, for upstream vs
// Hippo, and how many survive *nowhere* (neither verbatim nor in the summary).
//
// The summarizer is the same fixed-text stub `engineRunner.fakeModel` uses, so
// it never emits a fact marker by construction: "summary-only" is 0 for both
// arms and the verbatim column is the whole story. That is deliberate -- it
// makes information loss structural rather than a property of one model's
// prompt-following, and it is why "survives nowhere" here means "gone from the
// prompt", not "gone from the record" (the transcript itself is append-only).
//
// Bracket identity is *positional only*: every bracket writes its facts with
// one template, and the pending request is byte-identical in every phase.
// Nothing in the wording says "this one is the foundation", so retention
// cannot ride on a lexical hint the harness injected. The consequence is that
// all facts are roughly equidistant from the request, which makes the
// recency term the main non-uniform signal -- that is a real property of the
// shipped weights, not an artifact, and it is exactly what a long task has to
// survive.
//
// Seeds: `PILOTDECK_LONG_HORIZON_SEED_BASE` (default 20261021) so a reviewer
// can re-run the whole thing on a fresh seed set without editing code, in the
// same style as `PILOTDECK_HOLDOUT_SEED_BASE` / `PILOTDECK_EVAL_SEED_BASE`.
// Round count: `--rounds N` or `PILOTDECK_LONG_HORIZON_ROUNDS`.

const SEED_BASE = Number(process.env.PILOTDECK_LONG_HORIZON_SEED_BASE ?? "20261021");
const SEED_COUNT = Number(process.env.PILOTDECK_LONG_HORIZON_SEEDS ?? "3");
const PAIRS_PER_PHASE = Number(process.env.PILOTDECK_LONG_HORIZON_PAIRS ?? "60");
const FACTS_PER_BRACKET = Number(process.env.PILOTDECK_LONG_HORIZON_FACTS ?? "5");

const GENES = [
  "TP53", "CTNNB1", "TERT", "ARID1A", "RB1", "KRAS", "NRAS", "PIK3CA",
  "ALB", "APOB", "AXIN1", "BAP1",
];

const METHODS = [
  "Wasserstein", "TransDANN", "CoxPH", "KM", "LOOCV", "Concordance",
  "PCA", "UMAP", "DESeq2", "EdgeR",
];

const USER_NOISE = [
  "Inspect the intermediate QC table and reconcile sample annotations before the next stage.",
  "Run the expression normalization step and write the result into the batch queue.",
  "Check whether the clinical covariates are aligned with the mutation matrix row order.",
  "Recompute the survival fold split and store the fold file under the staging directory.",
  "Verify the manifest checksums and report any mismatch before model training.",
  "Inspect the cluster assignment drift between the source and target cohorts.",
  "Trim low-confidence records and rerun the phenotype summary for the clinical table.",
  "Refresh the cached mutation counts after the latest genotype call update.",
];

const ASSISTANT_NOISE = [
  "QC table read; 3 anomalies logged, matched pairs resolved, manifest checksum OK.",
  "Normalization completed and written; column order preserved, 2 warnings ignored.",
  "Clinical covariate order matches matrix rows; no remap required.",
  "Fold split written; seed fixed, class balance verified across all folds.",
  "Manifest checksums verified; staging artifact updated to latest revision.",
  "Cluster drift detected in 1 subgroup; source/target distance recorded for review.",
  "Low-confidence records removed; phenotype summary regenerated with stable counts.",
  "Mutation counts refreshed; index table rebuilt and cache invalidated.",
];

const NOISE_SUFFIX = [
  "expected_value=0.87 p_value=0.021 fold=3 reference_path=/staging/artifacts/survival/latest.tsv",
  "residuals=0.33 sample_count=184 batch_version=9 mutation_matrix=refs/heads/feature/cohort",
  "conditioner=0.74 pseudocount=2 cohort_lookup=/raw/clinical/samples.csv",
  "kernel_bandwidth=1.25 split_signature=sha256-9f3c source=target_distribution_note",
  "learning_rate=0.0003 optimizer=adam epochs=50 seed=7 checkpoint=/staging/checkpoints/fold-2.pt",
  "calibration_score=0.91 rank_correlation=0.44 phenotype_table=/raw/clinical/pheno-2026.tsv",
  "imputation_iterations=12 qc_threshold=0.8 gdc_manifest=/staging/manifests/manifest-latest.tsv",
  "covariate_shift=0.12 batch_effect=0.05 umap_components=2 pca_variance=0.67",
];

/**
 * The pending request, byte-identical in every phase. It has to be present at
 * the end of each phase: the tail-boundary logic anchors the kept tail on the
 * latest real user request, and the score policy uses it as the query hint. If
 * only the first phase carried one, later rounds would fall back differently in
 * each arm (it depends on whether that message was kept) and the two arms would
 * stop being comparable. Re-stating the same goal each phase is also what a
 * user actually does across a long session.
 */
const TASK_REQUEST =
  "Continue the TCGA-LIHC retention task. Answer the cohort n/frequency/statistic questions " +
  "from the exact FACT values recorded earlier in this session.";

export type Bracket = "foundation" | "mid" | "recent";

export type LongHorizonFact = {
  /** Globally unique, shared-template marker. Bracket identity is positional. */
  marker: string;
  text: string;
  /** Phase this fact is injected in; also the first round that can drop it. */
  bracketIndex: number;
  bracket: Bracket;
};

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

/**
 * Bracket 1 is the foundation, the bracket injected last is the recent one,
 * everything between is mid. With a single round there is no "mid"/"recent"
 * split to make, so bracket 1 stays the foundation.
 */
function bracketFor(bracketIndex: number, rounds: number): Bracket {
  if (bracketIndex === 1) return "foundation";
  if (bracketIndex === rounds) return "recent";
  return "mid";
}

type Phase = { messages: CanonicalMessage[] };

/**
 * Build the append-only task history as `rounds` phases, each ending in the
 * same pending request. Phase r carries bracket r's facts and is appended to
 * the conversation *after* round r-1 has already compacted, which is what puts
 * those facts in front of the next compaction rather than the first.
 */
export function generatePhases(options: {
  seed: number;
  rounds: number;
  pairsPerPhase: number;
  factsPerBracket: number;
}): { phases: Phase[]; facts: LongHorizonFact[] } {
  const random = mulberry32(options.seed);
  const phases: Phase[] = [];
  const facts: LongHorizonFact[] = [];

  for (let bracketIndex = 1; bracketIndex <= options.rounds; bracketIndex += 1) {
    const messages: CanonicalMessage[] = [];
    const spacing = Math.max(1, Math.floor(options.pairsPerPhase / options.factsPerBracket));
    let injected = 0;
    for (let index = 0; index < options.pairsPerPhase; index += 1) {
      let userText: string;
      if (index % spacing === 0 && injected < options.factsPerBracket) {
        const gene = pick(random, GENES);
        const method = pick(random, METHODS);
        const frequency = (Math.floor(random() * 90) + 5) / 100;
        const stat = Math.round((random() * 3.5 + 0.1) * 100) / 100;
        const marker = `FACT${facts.length + 1}`;
        const text = `${marker}: ${gene} ${method} TCGA-LIHC n=371 freq=${frequency.toFixed(3)} stat=${stat.toFixed(2)}`;
        facts.push({ marker, text, bracketIndex, bracket: bracketFor(bracketIndex, options.rounds) });
        injected += 1;
        userText = `${text} Record this exact value as a checkpoint.`;
      } else {
        userText = `${pick(random, USER_NOISE)} Step ${index + 1}: sample batch row=${random() < 0.5 ? 1 : 2} block=${Math.floor(random() * 8) + 1} gene=${pick(random, GENES)} metric=${Math.round(random() * 9000 + 1000)} ${pick(random, NOISE_SUFFIX)}`;
      }
      messages.push({ role: "user", content: [{ type: "text", text: userText }] });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `${pick(random, ASSISTANT_NOISE)} reply=${Math.floor(random() * 100000)} ${pick(random, NOISE_SUFFIX)}` }],
      });
    }
    messages.push({ role: "user", content: [{ type: "text", text: TASK_REQUEST }] });
    phases.push({ messages });
  }

  return { phases, facts };
}

function markersIn(facts: readonly LongHorizonFact[], text: string): Set<string> {
  return new Set(facts.filter((fact) => text.includes(fact.marker)).map((fact) => fact.marker));
}

export type RoundRecord = {
  round: number;
  preTokens: number;
  postTokens: number;
  messagesSummarized: number;
  messagesKept: number;
  /** Messages the Hippo policy pulled out of the summarize bucket (0 upstream). */
  retainedMessages: number;
  /** Harmless but useful: how many messages the previous round handed forward. */
  carriedInMessages: number;
  /** Facts verbatim in the round's INPUT (i.e. what survived the previous round). */
  inputVerbatim: number;
  atRisk: number;
  outputVerbatim: number;
  byBracket: Record<Bracket, number>;
  summaryOnly: number;
  survivesNowhere: number;
  fingerprint: string;
};

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Run one arm through all rounds. Each arm owns its own carry: upstream's
 * round-2 input is upstream's round-1 output, and likewise for Hippo. That
 * divergence is the point -- the arms are not given the same second input,
 * because in production they would not have the same context either.
 */
export async function runArm(options: {
  phases: Phase[];
  facts: LongHorizonFact[];
  variant: EngineVariant;
}): Promise<RoundRecord[]> {
  const records: RoundRecord[] = [];
  let carry: CanonicalMessage[] = [];

  for (let round = 1; round <= options.phases.length; round += 1) {
    const input = [...carry, ...options.phases[round - 1]!.messages];
    const inputText = input.map(messageVisibleText).join("\n");
    const carriedInMessages = carry.length;
    const run = await runEngine(input, options.variant);
    const verbatimText = run.fingerprint;
    const summaryText = run.result.summaryMessage ? messageVisibleText(run.result.summaryMessage) : "";

    const atRiskFacts = options.facts.filter((fact) => fact.bracketIndex <= round);
    const verbatimMarkers = markersIn(atRiskFacts, verbatimText);
    const summaryMarkers = markersIn(atRiskFacts, summaryText);
    const summaryOnly = [...summaryMarkers].filter((marker) => !verbatimMarkers.has(marker)).length;
    const byBracket: Record<Bracket, number> = { foundation: 0, mid: 0, recent: 0 };
    for (const marker of verbatimMarkers) {
      const fact = atRiskFacts.find((candidate) => candidate.marker === marker)!;
      byBracket[fact.bracket] += 1;
    }

    records.push({
      round,
      preTokens: run.result.preTokens,
      postTokens: run.postTokens,
      messagesSummarized: run.result.messagesSummarized,
      messagesKept: run.result.messagesToKeep.length,
      retainedMessages: run.result.retention?.retainedMessages ?? 0,
      carriedInMessages,
      inputVerbatim: markersIn(atRiskFacts, inputText).size,
      atRisk: atRiskFacts.length,
      outputVerbatim: verbatimMarkers.size,
      byBracket,
      summaryOnly,
      survivesNowhere: atRiskFacts.length - verbatimMarkers.size - summaryOnly,
      fingerprint: hashText(verbatimText),
    });

    // The next round's head is *this* round's real output, not a re-simulation.
    carry = run.postMessages;
  }

  return records;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Which bracket indexes a bracket label maps to. `mid` only exists as a label
 * when there are at least three rounds (with rounds<=2 there is nothing between
 * the foundation and the recent fact), so its index set is empty otherwise.
 */
function bracketIndexes(bracket: Bracket, rounds: number): number[] {
  if (bracket === "foundation") return [1];
  if (bracket === "recent") return rounds >= 2 ? [rounds] : [];
  const indexes: number[] = [];
  for (let index = 2; index < rounds; index += 1) indexes.push(index);
  return indexes;
}

/** A bracket exists at `round` once its first fact has been injected. */
function bracketExistsAtRound(bracket: Bracket, rounds: number, round: number): boolean {
  const indexes = bracketIndexes(bracket, rounds);
  return indexes.length > 0 && indexes[0]! <= round;
}

function intArgv(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    const value = Number(process.argv[index + 1]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return fallback;
}

/** One row of the per-round table, averaged over seeds. */
type PerRoundRow = {
  round: number;
  variant: EngineVariant;
  atRisk: number;
  inputVerbatim: number;
  outputVerbatim: number;
  foundation: number;
  mid: number;
  recent: number;
  summaryOnly: number;
  survivesNowhere: number;
  preTokens: number;
  postTokens: number;
  messagesSummarized: number;
  messagesKept: number;
  retainedMessages: number;
};

async function main() {
  const rounds = Math.max(1, intArgv("--rounds", Number(process.env.PILOTDECK_LONG_HORIZON_ROUNDS ?? "3")));
  const seeds = Array.from({ length: Math.max(1, SEED_COUNT) }, (_, offset) => SEED_BASE + offset);

  console.log(
    `long-horizon protocol: ${seeds.length} seeds (${seeds[0]}..${seeds[seeds.length - 1]}), ` +
      `${rounds} successive compaction rounds, ${PAIRS_PER_PHASE} pairs/phase, ` +
      `${FACTS_PER_BRACKET} facts/bracket\n`,
  );
  console.log(
    "Each round's input is the previous round's actual post-compaction output (carry-over,\n" +
      "not re-simulation). Summarizer is the fixed-text stub: it never emits a fact marker, so\n" +
      "'summary-only' is 0 structurally and 'nowhere' == 'not verbatim'.\n",
  );

  const variants: EngineVariant[] = ["upstream", "hippo"];
  type SeedRun = { seed: number; variant: EngineVariant; rounds: RoundRecord[] };
  const perSeed: SeedRun[] = [];
  const determinismFingerprints: string[] = [];

  for (const seed of seeds) {
    const { phases, facts } = generatePhases({ seed, rounds, pairsPerPhase: PAIRS_PER_PHASE, factsPerBracket: FACTS_PER_BRACKET });
    for (const variant of variants) {
      const records = await runArm({ phases, facts, variant });
      perSeed.push({ seed, variant, rounds: records });
      // Cheap determinism probe: only the first seed is re-run, and only for
      // Hippo, since upstream has nothing seeded to be non-deterministic with.
      if (seed === seeds[0] && variant === "hippo") {
        const repeat = await runArm({ phases, facts, variant });
        determinismFingerprints.push(records.map((record) => record.fingerprint).join("|"));
        determinismFingerprints.push(repeat.map((record) => record.fingerprint).join("|"));
      }
    }
  }

  const recordFor = (seed: number, variant: EngineVariant, round: number) =>
    perSeed.find((run) => run.seed === seed && run.variant === variant)!.rounds[round - 1]!;

  // ---- Table 1: per round, mean over seeds --------------------------------
  console.log("### Per round (mean over seeds; facts at risk grow by one bracket each round)\n");
  console.log("| round | variant | facts at risk | verbatim in input | verbatim in output | foundation | mid | recent | summary-only | survives nowhere | pre tokens | post tokens |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const perRoundRows: PerRoundRow[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const variant of variants) {
      const cells = seeds.map((seed) => recordFor(seed, variant, round));
      const row = {
        round,
        variant,
        atRisk: mean(cells.map((cell) => cell.atRisk)),
        inputVerbatim: mean(cells.map((cell) => cell.inputVerbatim)),
        outputVerbatim: mean(cells.map((cell) => cell.outputVerbatim)),
        foundation: mean(cells.map((cell) => cell.byBracket.foundation)),
        mid: mean(cells.map((cell) => cell.byBracket.mid)),
        recent: mean(cells.map((cell) => cell.byBracket.recent)),
        summaryOnly: mean(cells.map((cell) => cell.summaryOnly)),
        survivesNowhere: mean(cells.map((cell) => cell.survivesNowhere)),
        preTokens: Math.round(mean(cells.map((cell) => cell.preTokens))),
        postTokens: Math.round(mean(cells.map((cell) => cell.postTokens))),
        messagesSummarized: Math.round(mean(cells.map((cell) => cell.messagesSummarized))),
        messagesKept: Math.round(mean(cells.map((cell) => cell.messagesKept))),
        retainedMessages: mean(cells.map((cell) => cell.retainedMessages)),
      };
      perRoundRows.push(row);
      // A bracket column is "-" until the phase that injects it has run.
      const midCell = bracketExistsAtRound("mid", rounds, round) ? round2(row.mid) : "-";
      const recentCell = bracketExistsAtRound("recent", rounds, round) ? round2(row.recent) : "-";
      console.log(
        `| ${row.round} | ${row.variant} | ${row.atRisk} | ${round2(row.inputVerbatim)} | ${round2(row.outputVerbatim)} | ` +
          `${round2(row.foundation)} | ${midCell} | ${recentCell} | ` +
          `${round2(row.summaryOnly)} | ${round2(row.survivesNowhere)} | ${row.preTokens} | ${row.postTokens} |`,
      );
    }
  }

  // Carry-over audit: the mechanism this harness exists to exercise, made
  // visible. Round 1 hands nothing forward by definition; later rounds hand
  // forward the previous round's real post-compaction messages, so the input
  // verbatim count can exceed the facts the new phase just injected (that
  // excess is retention that survived a previous round, not a new fact).
  const carryAudit = Array.from({ length: rounds }, (_, index) => {
    const round = index + 1;
    const upstream = mean(seeds.map((seed) => recordFor(seed, "upstream", round).carriedInMessages));
    const hippo = mean(seeds.map((seed) => recordFor(seed, "hippo", round).carriedInMessages));
    const injected = round === 1 ? 0 : FACTS_PER_BRACKET;
    return { round, upstreamCarriedMessages: round2(upstream), hippoCarriedMessages: round2(hippo), factsInjectedByNewPhase: injected };
  });
  console.log(
    "\ncarry-over audit (messages handed forward into each round): " +
      carryAudit.map((entry) => `r${entry.round}=${entry.upstreamCarriedMessages}/${entry.hippoCarriedMessages}`).join(", ") +
      " (upstream/hippo)",
  );

  // ---- Table 2: final state per bracket ------------------------------------
  // Read after the LAST round only, so it answers "what is still there at the
  // end of the long task", not "what survived its first pass".
  console.log("\n### Final state by bracket (after the last round, mean over seeds)\n");
  console.log("| bracket | facts per seed | upstream verbatim | hippo verbatim | upstream nowhere | hippo nowhere |");
  console.log("|---|---:|---:|---:|---:|---:|");
  const brackets: Bracket[] = ["foundation", "mid", "recent"];
  const finalByBracket: Array<Record<string, unknown>> = [];
  for (const bracket of brackets) {
    const total = seeds
      .map((seed) => generatePhases({ seed, rounds, pairsPerPhase: PAIRS_PER_PHASE, factsPerBracket: FACTS_PER_BRACKET }).facts)
      .map((facts) => facts.filter((fact) => fact.bracket === bracket).length)[0] ?? 0;
    // A bracket only exists when there is a phase for it; with rounds=1 there is
    // no mid/recent bracket and the row is reported as absent rather than zero.
    const exists = total > 0;
    const upstreamFinal = seeds.map((seed) => recordFor(seed, "upstream", rounds));
    const hippoFinal = seeds.map((seed) => recordFor(seed, "hippo", rounds));
    const upstreamVerbatim = mean(upstreamFinal.map((cell) => cell.byBracket[bracket]));
    const hippoVerbatim = mean(hippoFinal.map((cell) => cell.byBracket[bracket]));
    const row = {
      bracket,
      factsPerSeed: total,
      upstreamVerbatim: round2(upstreamVerbatim),
      hippoVerbatim: round2(hippoVerbatim),
      upstreamNowhere: round2(exists ? total - upstreamVerbatim : 0),
      hippoNowhere: round2(exists ? total - hippoVerbatim : 0),
    };
    finalByBracket.push(row);
    console.log(
      `| ${bracket} | ${total} | ${exists ? row.upstreamVerbatim : "-"} | ${exists ? row.hippoVerbatim : "-"} | ` +
        `${exists ? row.upstreamNowhere : "-"} | ${exists ? row.hippoNowhere : "-"} |`,
    );
  }

  // ---- Table 3: the foundation decay curve ---------------------------------
  // The single most important read for a long task: how many of the facts that
  // existed before round 1 are still verbatim after each subsequent round.
  console.log("\n### Foundation-fact decay (bracket 1 facts still verbatim after each round)\n");
  console.log("| round | upstream (of " + FACTS_PER_BRACKET + ") | hippo (of " + FACTS_PER_BRACKET + ") |");
  console.log("|---|---:|---:|");
  const foundationDecay: Array<Record<string, unknown>> = [];
  for (let round = 1; round <= rounds; round += 1) {
    const upstream = mean(seeds.map((seed) => recordFor(seed, "upstream", round).byBracket.foundation));
    const hippo = mean(seeds.map((seed) => recordFor(seed, "hippo", round).byBracket.foundation));
    foundationDecay.push({ round, upstream: round2(upstream), hippo: round2(hippo) });
    console.log(`| ${round} | ${round2(upstream)} | ${round2(hippo)} |`);
  }

  // ---- Honest read-out: where Hippo loses, and where it gains nothing ------
  // Losses and ties are reported separately. A tie on the foundation bracket is
  // the finding that matters most for a long task -- it means the extra
  // verbatim budget bought nothing for the facts that had the longest to
  // travel -- so it must not be silently folded into "wins".
  const notBetter: string[] = [];
  const ties: string[] = [];
  for (const row of perRoundRows) {
    if (row.variant !== "hippo") continue;
    const upstreamRow = perRoundRows.find((candidate) => candidate.round === row.round && candidate.variant === "upstream")!;
    for (const key of ["outputVerbatim", "foundation", "mid", "recent"] as const) {
      const exists = key === "outputVerbatim"
        || bracketExistsAtRound(key, rounds, row.round);
      if (!exists) continue;
      const upstreamValue = upstreamRow[key];
      const hippoValue = row[key];
      if (hippoValue < upstreamValue) {
        notBetter.push(`round ${row.round} ${key}: hippo ${round2(hippoValue)} < upstream ${round2(upstreamValue)}`);
      } else if (hippoValue === upstreamValue) {
        ties.push(`round ${row.round} ${key}: both ${round2(hippoValue)}`);
      }
    }
  }
  console.log("\n### Cells where Hippo LOSES to upstream\n");
  console.log(notBetter.length === 0 ? "(none)" : notBetter.map((line) => `- ${line}`).join("\n"));
  console.log("\n### Cells where Hippo only ties upstream\n");
  console.log(ties.length === 0 ? "(none)" : ties.map((line) => `- ${line}`).join("\n"));

  const deterministic = determinismFingerprints.length === 2
    && determinismFingerprints[0] === determinismFingerprints[1];
  console.log(`\ndeterministic (hippo, seed ${seeds[0]} re-run): ${deterministic}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    protocol: "benchmarks/longHorizon.ts",
    timestamp,
    seedBase: SEED_BASE,
    seeds,
    rounds,
    pairsPerPhase: PAIRS_PER_PHASE,
    factsPerBracket: FACTS_PER_BRACKET,
    metric:
      "fact markers (verbatim) and information loss in the post-compaction prompt after each successive compaction round",
    summarizer: "engineRunner.fakeModel fixed-text stub -- never emits a fact marker, so summary-only is 0 by construction",
    scorePolicy: "ebbinghaus-pagerank (shipped default); upstream arm has no scorePolicy",
    carryOver: "round r input = buildPostCompactMessages(round r-1 result) + phase r messages",
    // Which side of the `PILOTDECK_CARRYOVER` switch produced this file, so the
    // two committed arms are self-describing instead of needing the command line
    // to tell them apart.
    carryOverMode: isCarryOverEnabled() ? "on (shipped default)" : "off",
    deterministic,
    perRound: perRoundRows,
    carryAudit,
    finalByBracket,
    foundationDecay,
    hippoNotBetter: notBetter,
    hippoTies: ties,
    raw: perSeed,
  };
  const resultsDir = resolve(join(process.cwd(), "benchmarks", "results"));
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = resolve(resultsDir, `long-horizon-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log("\nresults written:", outputPath);
}

// Nothing imports this file yet, but the guard matches topicSwitch.ts so an
// importer never triggers a results write as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
