/**
 * Export one real compaction step, message by message, for the interactive
 * explainer page.
 *
 * What this is
 * ------------
 * A deterministic replay of the *real* engine over a fixed synthetic
 * transcript with the fake summarizer model (`benchmarks/engineRunner.ts`).
 * No network, no API key, no live model: the summary text is a fixed string.
 * The numbers it writes are the numbers the engine actually computed on this
 * run, not hand-written examples.
 *
 * How the per-candidate score breakdown is obtained without re-implementing
 * the formula
 * ---------------------------------------------------------------------------
 * The engine's own `EbbinghausPageRankPolicy.pickRetained` is wrapped in a
 * recording proxy (`RecordingPolicy` below) that forwards to the real policy
 * and only captures its inputs: the exact candidate list, the query hint and
 * the retention token budget the engine passed. The proxy changes nothing the
 * engine sees, so the engine's behaviour is unaffected.
 *
 * The per-candidate components are then read out of the *policy's own*
 * `scoreMessages`, by constructing three probe policies whose weight triples
 * isolate one term each:
 *
 *   wSim=1,wTime=0,wRank=0  -> S(m) = sim
 *   wSim=0,wTime=1,wRank=0  -> S(m) = position_decay
 *   wSim=0,wTime=0,wRank=1  -> S(m) = idf_pagerank
 *
 * `EbbinghausPageRankPolicy.weights` normalizes by `max(1, sum)`, so each probe
 * weight triple is (1,0,0) after normalization and the returned score IS the
 * raw component. The final score is likewise taken from the policy with its
 * default weights (0.85/0.15/0) -- the same policy instance the engine used --
 * and cross-checked against the weighted sum of the three components.
 *
 * The budget-truncation order is read back from the policy too:
 * `pickRetained` with an unbounded budget returns every retainable candidate in
 * the policy's own score order. The export then walks that order with the
 * engine's greedy rule and asserts the resulting set is identical to what the
 * engine's own `pickRetained` returned. If that assertion ever fails, the
 * export throws instead of shipping numbers the engine did not use.
 *
 * Run: npx tsx benchmarks/demo/exportFlow.ts [outPath]
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPostCompactMessages, CompactionEngine } from "../../src/context/compaction/CompactionEngine.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import { messageVisibleText } from "../../src/context/compaction/retention/MessageText.js";
import { isSyntheticPseudoMessage } from "../../src/context/compaction/toolPairIntegrity.js";
import {
  buildEbbinghausPageRankPolicy,
  EBBINGHAUS_DEFAULT_WEIGHTS,
} from "../../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import { defaultEmbeddingModelPath } from "../../src/context/compaction/retention/LocalEmbedding.js";
import type { RetentionScorePolicy } from "../../src/context/compaction/retention/RetentionTypes.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import { fakeModel } from "../engineRunner.js";
import { factPresent } from "../factPresent.js";
import { generateTranscript } from "../syntheticTranscript.js";

// ---------------------------------------------------------------------------
// Fixed configuration (mirrors benchmarks/engineRunner.ts + run-demo.ts)
// ---------------------------------------------------------------------------

const SEED = 20260911;
const NUM_PAIRS = 40;
const FACTS_COUNT = 8;
const KEEP_TAIL_RATIO = 0.18;
const MAX_OUTPUT_TOKENS = 1200;
const RETENTION_BUDGET_RATIO = 0.2;
const RETENTION_BUDGET_FLOOR = 256;
const PREVIEW_CHARS = 180;

const PREVIEW_DEFAULT_OUT =
  "/data/qiushuogeng/pilotdeck-demo-0912/sections/flow.json";

const UNBOUNDED_BUDGET = Number.MAX_SAFE_INTEGER;

/** Source files whose exact revision produced the exported numbers. */
const FINGERPRINTED_SOURCES = [
  "src/context/compaction/CompactionEngine.ts",
  "src/context/compaction/retention/EbbinghausPageRankPolicy.ts",
  "src/context/compaction/retention/EbbinghausScore.ts",
  "src/context/compaction/retention/EntityGraph.ts",
  "src/context/compaction/retention/LocalEmbedding.ts",
  "src/context/compaction/retention/MessageText.ts",
  "src/context/compaction/toolPairIntegrity.ts",
];

function sourceFingerprints(): Record<string, string> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const out: Record<string, string> = {};
  for (const relative of FINGERPRINTED_SOURCES) {
    const absolute = resolve(repoRoot, relative);
    if (!existsSync(absolute)) continue;
    out[relative] = createHash("sha256").update(readFileSync(absolute)).digest("hex").slice(0, 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recording proxy: captures exactly what the engine hands the policy.
// ---------------------------------------------------------------------------

type CapturedCall = {
  candidates: CanonicalMessage[];
  queryHint: string;
  retentionBudgetTokens: number;
  retained: CanonicalMessage[];
};

class RecordingPolicy implements RetentionScorePolicy {
  readonly id: string;
  captured: CapturedCall | undefined;
  estimateTokens: ((messages: CanonicalMessage[]) => number) | undefined;

  constructor(private readonly inner: RetentionScorePolicy) {
    this.id = inner.id;
  }

  /** Mirror the inner policy's self-reported weights (engine reads this). */
  get weights(): { wSim: number; wTime: number; wRank: number } | undefined {
    return this.inner.weights;
  }

  async scoreMessages(input: {
    candidates: CanonicalMessage[];
    queryHint?: string;
  }): Promise<Map<CanonicalMessage, number>> {
    return this.inner.scoreMessages(input);
  }

  async pickRetained(input: {
    candidates: CanonicalMessage[];
    retentionBudgetTokens: number;
    queryHint?: string;
    estimateTokens: (candidates: CanonicalMessage[]) => number;
  }): Promise<CanonicalMessage[]> {
    const retained = await this.inner.pickRetained(input);
    this.captured = {
      candidates: [...input.candidates],
      queryHint: input.queryHint ?? "",
      retentionBudgetTokens: input.retentionBudgetTokens,
      retained: [...retained],
    };
    this.estimateTokens = input.estimateTokens;
    return retained;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}…`;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fail(message: string): never {
  throw new Error(`exportFlow: ${message}`);
}

/** Engine construction, copied from benchmarks/engineRunner.ts's runEngine. */
function buildEngine(scorePolicy: RetentionScorePolicy | undefined): CompactionEngine {
  return new CompactionEngine({
    model: fakeModel,
    provider: "benchmark",
    model_: "benchmark-summarizer",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    scorePolicy,
  });
}

async function runArm(messages: CanonicalMessage[], scorePolicy?: RetentionScorePolicy) {
  const result = await buildEngine(scorePolicy).run({
    trigger: "auto",
    messages,
    keepTailRatio: KEEP_TAIL_RATIO,
    protectedToolNames: null,
  });
  const postMessages = buildPostCompactMessages(result);
  const postTokens = result.postTokens
    ?? new TokenBudgetManager().estimateMessagesTokens(postMessages);
  return { result, postMessages, postTokens };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? PREVIEW_DEFAULT_OUT);

  if (defaultEmbeddingModelPath() !== "") {
    fail(
      "PILOTDECK_BGE_MODEL is set; this export must run offline with the BM25 "
        + "fallback so the semantic backend is deterministic.",
    );
  }

  const transcript = generateTranscript({
    numPairs: NUM_PAIRS,
    seed: SEED,
    factsCount: FACTS_COUNT,
  });
  const messages = transcript.messages;
  const tokens = new TokenBudgetManager();
  const perMessageTokens = messages.map((message) => tokens.estimateForMessage(message));

  // ---- Arm 1: upstream (no score policy) --------------------------------
  const upstream = await runArm(messages, undefined);

  // ---- Arm 2: Hippo (real policy behind a recording proxy) --------------
  const realPolicy = buildEbbinghausPageRankPolicy();
  const recorder = new RecordingPolicy(realPolicy);
  const hippo = await runArm(messages, recorder);

  const captured = recorder.captured;
  if (!captured) {
    fail("the engine never called pickRetained; nothing to export");
  }
  if (!recorder.estimateTokens) {
    fail("the engine did not pass an estimateTokens function");
  }
  const estimateTokens = recorder.estimateTokens;

  const candidates = captured.candidates;
  const queryHint = captured.queryHint;
  const retentionBudgetTokens = captured.retentionBudgetTokens;

  // The candidate list is whatever the engine handed the policy, so it is the
  // single source of truth for "messages that were about to be summarized".
  // The bucket the engine actually summarizes must be exactly that list minus
  // the retained originals: the engine keeps `retainedMessages` as the original
  // objects and filters the bucket with them (`retainedForOutput` is the
  // annotated copy it hands to the output step, never the filter key). If a
  // change ever breaks that again, fail here rather than publish a page that
  // explains a gap that should not exist.
  const summarizedByEngine = hippo.result.messagesSummarized;
  const candidateMinusRetained = candidates.length - captured.retained.length;
  const accountingConsistent = summarizedByEngine === candidateMinusRetained;
  if (!accountingConsistent) {
    fail(
      `summary bucket mismatch: engine reports messagesSummarized=${summarizedByEngine} `
        + `but candidates − retained = ${candidateMinusRetained}; the retained originals `
        + "are not being removed from the summary bucket.",
    );
  }

  // ---- Component probes (the policy's own scoring code, one term each) --
  const probe = async (wSim: number, wTime: number, wRank: number) => {
    const policy = buildEbbinghausPageRankPolicy({ wSim, wTime, wRank });
    const map = await policy.scoreMessages({ candidates, queryHint });
    return candidates.map((message) => map.get(message) ?? 0);
  };
  const simScores = await probe(1, 0, 0);
  const decayScores = await probe(0, 1, 0);
  const rankScores = await probe(0, 0, 1);

  // Final scores from the same policy instance the engine scored with.
  const defaultMap = await realPolicy.scoreMessages({ candidates, queryHint });
  const defaultScores = candidates.map((message) => defaultMap.get(message) ?? 0);

  const weights = realPolicy.weights;
  const composed = candidates.map((_, index) =>
    Math.max(
      0,
      Math.min(
        1,
        weights.wSim * (simScores[index] ?? 0)
          + weights.wTime * (decayScores[index] ?? 0)
          + weights.wRank * (rankScores[index] ?? 0),
      ),
    ));
  for (let index = 0; index < candidates.length; index += 1) {
    if (Math.abs(composed[index]! - defaultScores[index]!) > 1e-9) {
      fail(`component composition does not reproduce the policy score at candidate ${index}`);
    }
  }

  // ---- Retention order + greedy budget walk -----------------------------
  // Unbounded budget -> every retainable candidate, in the policy's own order.
  const retainable = await realPolicy.pickRetained({
    candidates,
    retentionBudgetTokens: UNBOUNDED_BUDGET,
    queryHint,
    estimateTokens,
  });
  const order = retainable.map((message) => candidates.indexOf(message));
  if (order.some((index) => index < 0)) fail("policy returned a message outside the candidate list");

  type SelectionStep = {
    index: number;
    tokens: number;
    cumulativeTokens: number;
    fits: boolean;
    skipReason?: string;
  };
  const steps: SelectionStep[] = [];
  const selectedIndexes = new Set<number>();
  let usedTokens = 0;
  for (const index of order) {
    const message = candidates[index]!;
    const messageTokens = estimateTokens([message]);
    if (messageTokens <= 0) {
      steps.push({ index, tokens: messageTokens, cumulativeTokens: usedTokens, fits: false, skipReason: "zero-token" });
      continue;
    }
    if (messageVisibleText(message).length === 0) {
      steps.push({ index, tokens: messageTokens, cumulativeTokens: usedTokens, fits: false, skipReason: "no-visible-text" });
      continue;
    }
    if (isSyntheticPseudoMessage(message)) {
      steps.push({ index, tokens: messageTokens, cumulativeTokens: usedTokens, fits: false, skipReason: "synthetic-pseudo-message" });
      continue;
    }
    if (usedTokens + messageTokens > retentionBudgetTokens) {
      steps.push({ index, tokens: messageTokens, cumulativeTokens: usedTokens, fits: false, skipReason: "over-budget" });
      continue;
    }
    usedTokens += messageTokens;
    selectedIndexes.add(index);
    steps.push({ index, tokens: messageTokens, cumulativeTokens: usedTokens, fits: true });
  }

  // The greedy walk above must reproduce exactly what the engine retained.
  const engineRetainedIndexes = captured.retained
    .map((message) => candidates.indexOf(message))
    .sort((left, right) => left - right);
  const greedyIndexes = [...selectedIndexes].sort((left, right) => left - right);
  if (JSON.stringify(engineRetainedIndexes) !== JSON.stringify(greedyIndexes)) {
    fail(
      `greedy reproduction mismatch: engine=[${engineRetainedIndexes.join(",")}] `
        + `greedy=[${greedyIndexes.join(",")}]`,
    );
  }
  const engineRetainedTokens = hippo.result.retention?.retainedTokens ?? 0;
  if (engineRetainedTokens !== usedTokens) {
    fail(`retained token mismatch: engine=${engineRetainedTokens} greedy=${usedTokens}`);
  }

  // ---- Tail / protected classification ---------------------------------
  // `messagesToKeep` ends with the verbatim tail, which is a contiguous suffix
  // of the transcript. Walk back from the end while the kept context still
  // contains that message's text: that run is the tail. Any earlier kept
  // message is either a retained original or a protected (pinned) prefix
  // message. Matching on text rather than object identity keeps this working
  // when the engine has replaced a message with an annotated copy.
  const keptTexts = new Set(hippo.result.messagesToKeep.map(messageVisibleText));
  const candidateSet = new Set(candidates);
  const retainedTexts = new Set(
    hippo.result.retention?.retainedMessageTexts ?? captured.retained.map(messageVisibleText),
  );
  let tailStart = messages.length;
  while (tailStart > 0 && keptTexts.has(messageVisibleText(messages[tailStart - 1]!))) {
    tailStart -= 1;
  }
  if (!keptTexts.has(messageVisibleText(messages[messages.length - 1]!))) {
    fail("the tail is empty; the explainer assumes a verbatim tail");
  }
  const tailCount = messages.length - tailStart;

  // ---- Transcript view --------------------------------------------------
  const factIndexOf = new Map<string, number>();
  transcript.facts.forEach((fact, index) => factIndexOf.set(fact.marker, index));

  const transcriptRows = messages.map((message, index) => {
    const text = messageVisibleText(message);
    let bucket: "tail" | "candidate" | "retained" | "protected";
    if (index >= tailStart) bucket = "tail";
    else if (retainedTexts.has(text)) bucket = "retained";
    else if (candidateSet.has(message)) bucket = "candidate";
    else bucket = "protected";
    const row: Record<string, unknown> = {
      i: index,
      role: message.role,
      tokens: perMessageTokens[index]!,
      bucket,
      preview: preview(text),
    };
    for (const [marker, factIndex] of factIndexOf) {
      if (factPresent(text, marker)) row.fact = factIndex;
    }
    return row;
  });

  // ---- Candidate score table -------------------------------------------
  const stepByIndex = new Map(steps.map((step) => [step.index, step]));
  const candidateRows = candidates.map((message, candidateIndex) => {
    const transcriptIndex = messages.indexOf(message);
    const step = stepByIndex.get(candidateIndex)!;
    const row: Record<string, unknown> = {
      i: transcriptIndex,
      c: candidateIndex,
      role: message.role,
      tokens: perMessageTokens[transcriptIndex]!,
      sim: round(simScores[candidateIndex]!),
      decay: round(decayScores[candidateIndex]!),
      rank: round(rankScores[candidateIndex]!),
      score: round(defaultScores[candidateIndex]!),
      rank1: order.indexOf(candidateIndex) + 1,
      selected: step.fits,
      cumulativeTokens: step.cumulativeTokens,
      preview: preview(messageVisibleText(message)),
    };
    if (step.skipReason) row.skipReason = step.skipReason;
    for (const [marker, factIndex] of factIndexOf) {
      if (factPresent(messageVisibleText(message), marker)) row.fact = factIndex;
    }
    return row;
  });

  // ---- Facts ------------------------------------------------------------
  const upstreamFingerprint = upstream.postMessages.map(messageVisibleText).join("\n");
  const hippoFingerprint = hippo.postMessages.map(messageVisibleText).join("\n");
  const factRows = transcript.facts.map((fact, index) => ({
    index,
    marker: fact.marker,
    text: fact.text,
    inUpstream: factPresent(upstreamFingerprint, fact.marker),
    inHippo: factPresent(hippoFingerprint, fact.marker),
  }));

  // ---- Post-compaction context for both arms ---------------------------
  const contextRows = (postMessages: CanonicalMessage[], summaryMessage?: CanonicalMessage) =>
    postMessages.map((message) => {
      const text = messageVisibleText(message);
      let kind: string;
      if (text.startsWith("<compact-boundary")) kind = "boundary";
      else if (message === summaryMessage) kind = "summary";
      else if (retainedTexts.has(text)) kind = "retained-original";
      else kind = "kept-verbatim";
      return {
        role: message.role,
        kind,
        tokens: tokens.estimateForMessage(message),
        preview: preview(text),
      };
    });

  // ---- Budget arithmetic -----------------------------------------------
  const preTokens = hippo.result.preTokens;
  if (upstream.result.preTokens !== preTokens) fail("arms disagree on preTokens");
  const tailTokenBudget = Math.max(1, Math.floor(preTokens * KEEP_TAIL_RATIO));
  if (tailTokenBudget !== Math.max(1, Math.floor(upstream.result.preTokens * KEEP_TAIL_RATIO))) {
    fail("tail budget formula drift");
  }
  const expectedRetentionBudget = Math.max(
    RETENTION_BUDGET_FLOOR,
    Math.floor(tailTokenBudget * RETENTION_BUDGET_RATIO),
  );
  if (retentionBudgetTokens !== expectedRetentionBudget) {
    fail(
      `retention budget drift: engine=${retentionBudgetTokens} expected=${expectedRetentionBudget}`,
    );
  }

  const queryIndex = messages.findIndex((message) => messageVisibleText(message) === queryHint);
  if (queryIndex < 0) fail("could not locate the query message the engine scored against");

  // A message a *previous* compaction kept carries a marker from
  // `retention/CarryOver.ts`, which reserves a capped slice of the retention
  // budget for it (a cap on spend, not a score bonus). This export is a single
  // fresh pass, so no candidate can carry the marker; if one ever does, the
  // greedy walk below would no longer reproduce the engine's retained set and
  // the checks would throw rather than publish a wrong breakdown.
  const carryOverMarked = candidates.filter((message) =>
    (message.metadata as { hippoRetained?: boolean } | undefined)?.hippoRetained === true).length;

  const flow = {
    meta: {
      what: "one real compaction step, replayed offline over a fixed seed",
      engine: "CompactionEngine + EbbinghausPageRankPolicy (this repo)",
      runScript: "benchmarks/demo/exportFlow.ts",
      command: "npx tsx benchmarks/demo/exportFlow.ts",
      summarizer: "fakeModel (benchmarks/engineRunner.ts) — fixed text, no network, no API key",
      semanticBackend: "bm25-lexical (BM25 over message text; offline fallback of LocalEmbedding)",
      seed: SEED,
      numPairs: NUM_PAIRS,
      factsInjected: transcript.facts.length,
      keepTailRatio: KEEP_TAIL_RATIO,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      weights: { wSim: weights.wSim, wTime: weights.wTime, wRank: weights.wRank },
      replay: "deterministic: two runs write byte-identical JSON",
      sourceFingerprints: sourceFingerprints(),
      carryOverMarkedCandidates: carryOverMarked,
    },
    formula: {
      score: "S(m) = wSim·sim(q,m) + wTime·position_decay(m) + wRank·idf_pagerank(m)",
      query: "q = the most recent real user request in the conversation",
      retentionBudget: "max(256, floor(tailTokenBudget × 0.2))",
      tailBudget: "floor(preTokens × keepTailRatio)",
      simplification:
        "budget truncation in the engine walks the score order and SKIPS a message "
        + "that does not fit, then keeps scanning; it does not stop at the first miss.",
    },
    budget: {
      preTokens,
      keepTailRatio: KEEP_TAIL_RATIO,
      tailTokenBudget,
      tailTokenBudgetFormula: `floor(${preTokens} × ${KEEP_TAIL_RATIO}) = ${tailTokenBudget}`,
      retentionRatio: RETENTION_BUDGET_RATIO,
      retentionFloor: RETENTION_BUDGET_FLOOR,
      retentionBudgetTokens,
      retentionBudgetFormula:
        `max(${RETENTION_BUDGET_FLOOR}, floor(${tailTokenBudget} × ${RETENTION_BUDGET_RATIO}))`
        + ` = ${retentionBudgetTokens}`,
      tailStartIndex: tailStart,
      tailMessages: tailCount,
      candidateCount: candidates.length,
      retainedCount: captured.retained.length,
      retainedTokens: usedTokens,
      droppedCount: candidates.length - captured.retained.length,
      engineReportedSummarized: summarizedByEngine,
      engineReportedSummarizedNote:
        "candidates − retained: the retained originals are removed from the summary "
        + "bucket and replayed verbatim instead (asserted at export time)",
      queryHint: preview(queryHint),
      queryIndex,
    },
    transcript: transcriptRows,
    candidates: candidateRows,
    selection: steps.map((step) => ({
      c: step.index,
      i: messages.indexOf(candidates[step.index]!),
      tokens: step.tokens,
      cumulativeTokens: step.cumulativeTokens,
      fits: step.fits,
      ...(step.skipReason ? { skipReason: step.skipReason } : {}),
    })),
    facts: factRows,
    arms: {
      upstream: {
        postTokens: upstream.postTokens,
        summaryText:
          "Upstream summarizes the whole candidate bucket and keeps nothing from it verbatim.",
        context: contextRows(upstream.postMessages, upstream.result.summaryMessage),
      },
      hippo: {
        postTokens: hippo.postTokens,
        summaryText:
          `Hippo adds ${captured.retained.length} message(s) pulled out of the bucket, `
          + `kept word-for-word beside the same summary.`,
        retainedTokens: usedTokens,
        context: contextRows(hippo.postMessages, hippo.result.summaryMessage),
      },
    },
    checks: {
      /** The greedy budget walk reproduced the engine's retained set exactly. */
      greedyMatchesEngine: true,
      /** wSim·sim + wTime·decay + wRank·rank reproduces the policy's score. */
      scoreComposes: true,
      /** engine-reported retained tokens equal the greedy running total. */
      retainedTokensMatchEngine: true,
      retentionBudgetMatchesFormula: true,
      embeddingBackendOffline: true,
      /** result.messagesSummarized equals candidates − retained (asserted above). */
      summarizedCountMatchesBucket: accountingConsistent,
    },
  };

  const json = `${JSON.stringify(flow, null, 1)}\n`;
  writeFileSync(outPath, json, "utf8");
  const bytes = Buffer.byteLength(json, "utf8");

  // ---- stdout summary (deterministic) ----------------------------------
  const lines: string[] = [];
  lines.push("============================================================");
  lines.push(`exportFlow: seed=${SEED} pairs=${NUM_PAIRS} facts=${transcript.facts.length}`);
  lines.push(`summarizer: fakeModel (offline)  semantic: bm25-lexical`);
  lines.push("============================================================");
  lines.push(`messages                 : ${messages.length}`);
  lines.push(`preTokens                : ${preTokens}`);
  lines.push(`tailTokenBudget          : ${tailTokenBudget}  (${tailTokenBudget}=floor(${preTokens}×${KEEP_TAIL_RATIO}))`);
  lines.push(`retentionBudgetTokens    : ${retentionBudgetTokens}  (max(${RETENTION_BUDGET_FLOOR}, floor(${tailTokenBudget}×${RETENTION_BUDGET_RATIO})))`);
  lines.push(`tail (verbatim, unscored): ${tailCount} messages, index ${tailStart}..${messages.length - 1}`);
  lines.push(`candidates scored        : ${candidates.length}`);
  lines.push(`retained verbatim        : ${captured.retained.length} messages, ${usedTokens} tokens`);
  lines.push(`dropped from retention   : ${candidates.length - captured.retained.length}`);
  lines.push(`postTokens upstream/hippo: ${upstream.postTokens} / ${hippo.postTokens}`);
  lines.push(`messagesSummarized u/h   : ${upstream.result.messagesSummarized} / ${summarizedByEngine}`);
  lines.push(`carry-over marked cands  : ${carryOverMarked}`);
  lines.push(`checks                   : greedy=${true} compose=${true} `
    + `retainedTokens=${engineRetainedTokens === usedTokens} summarizedBucket=${accountingConsistent}`);
  lines.push(`FACTs kept u/h           : ${factRows.filter((f) => f.inUpstream).length} / ${factRows.filter((f) => f.inHippo).length} of ${factRows.length}`);
  lines.push("");
  lines.push("Retention order (score desc, budget walk):");
  for (const step of steps.slice(0, 12)) {
    const row = candidateRows[step.index]!;
    lines.push(
      `  #${String(row.rank1).padStart(2)} idx=${String(row.i).padStart(3)} `
        + `score=${(row.score as number).toFixed(4)} `
        + `sim=${(row.sim as number).toFixed(4)} decay=${(row.decay as number).toFixed(4)} `
        + `rank=${(row.rank as number).toFixed(4)} `
        + `tok=${String(step.tokens).padStart(4)} cum=${String(step.cumulativeTokens).padStart(4)} `
        + `${step.fits ? "KEEP" : `DROP(${step.skipReason})`}`,
    );
  }
  if (steps.length > 12) lines.push(`  … ${steps.length - 12} more`);
  lines.push("");
  lines.push(`wrote ${outPath} (${bytes} bytes = ${(bytes / 1024).toFixed(1)} KB)`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

void main();
