import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runEngine } from "../engineRunner.js";
import { generateTranscript, type SyntheticFact } from "../syntheticTranscript.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import { messageVisibleText } from "../../src/context/compaction/retention/MessageText.js";
import {
  buildEbbinghausPageRankPolicy,
  EBBINGHAUS_DEFAULT_WEIGHTS,
} from "../../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import type { RetentionScorePolicy } from "../../src/context/compaction/retention/RetentionTypes.js";
import type { CanonicalMessage } from "../../src/model/index.js";

// Judge-page export: the real post-compaction context, upstream vs Hippo, side by side.
//
// This is NOT a new metric and NOT a new benchmark. It is the *page renderer's*
// data source: the exact same deterministic case the structural benchmark uses
// (`generateTranscript({ numPairs: 160, seed: 20260911 })`, run through
// `engineRunner.runEngine` with the same fake summarizer and the same
// `keepTailRatio: 0.18`), dumped in enough detail that a judge can see, message
// by message, what survived compaction in each arm and why.
//
// Two things it adds over `abHarness.ts`:
//
//   1. Message-level fate for every injected fact (`verbatim` / `summary-only` /
//      `absent`), with the facts that were folded away left in place as explicit
//      gaps instead of being silently dropped.
//   2. The real per-message retention decisions of the shipped policy. The
//      engine does not expose its candidate list, so the policy is wrapped in a
//      transparent spy that records the exact `pickRetained` input and then
//      delegates to the shipped `EbbinghausPageRankPolicy`. The scores dumped
//      for the page are that same policy's own `scoreMessages` output on that
//      same input -- not a re-implementation.
//
// Honesty notes carried into the JSON so the page cannot overstate them:
//   * The summarizer is `engineRunner.fakeModel`, a fixed-text stub that never
//     emits a fact marker. "summary-only" is therefore 0 by construction, and
//     upstream's 0/20 is the *structural* lossy-summary contrast, not a ceiling
//     on what a real summarizer can do (docs/evaluation.en.md §4.3).
//   * No timestamp is written. The file must be byte-identical across runs;
//     that is checked by running the script twice and diffing.

const NUM_PAIRS = 160;
const SEED = 20260911;
const FACTS_COUNT = 20;
const KEEP_TAIL_RATIO = 0.18;
/** Cosine of the page's own display cap on a message preview (chars). */
const PREVIEW_CHARS = 320;
const CANDIDATE_PREVIEW_CHARS = 180;
const DEFAULT_OUT = "/data/qiushuogeng/pilotdeck-demo-0912/sections/context-diff.json";

type ArmKey = "upstream" | "hippo";

type ScoredCandidate = {
  /** Index in the pre-compaction transcript. */
  i: number;
  role: string;
  /** Preview of the scored text (the same `messageVisibleText` the policy scores). */
  text: string;
  truncated: boolean;
  /** Raw policy score. */
  score: number;
  /** True when `pickRetained` actually kept this candidate. */
  retained: boolean;
  /** FACT markers whose full text is inside this message. */
  facts: string[];
};

function preview(text: string, max: number): { text: string; truncated: boolean } {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return { text: collapsed, truncated: false };
  return { text: `${collapsed.slice(0, max - 1)}…`, truncated: true };
}

function factsInText(facts: readonly SyntheticFact[], text: string): string[] {
  return facts.filter((fact) => text.includes(fact.text)).map((fact) => fact.marker);
}

/** `FACT7: TP53 CoxPH TCGA-LIHC n=371 freq=0.420 stat=1.10` -> the value after the marker. */
function factValue(fact: SyntheticFact): string {
  return fact.text.replace(/^FACT\d+:\s*/, "");
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Revision stamp for the numbers below. The engine is live code under active
 * edit, so "which revision produced this" has to travel with the JSON rather
 * than be assumed from the date. Digest covers exactly the files whose behavior
 * this export depends on; it changes when they do, which is the point.
 */
function sourceRevision(): { gitHead: string | null; sourceDigest: string; files: string[] } {
  const repoRoot = resolve(dirname(import.meta.filename), "..", "..");
  const files = [
    "src/context/compaction/CompactionEngine.ts",
    "src/context/compaction/retention/EbbinghausPageRankPolicy.ts",
    "src/context/compaction/retention/EbbinghausScore.ts",
    "src/context/compaction/retention/EntityGraph.ts",
    "src/context/compaction/retention/CarryOver.ts",
    "benchmarks/engineRunner.ts",
    "benchmarks/syntheticTranscript.ts",
  ];
  const hash = createHash("sha256");
  for (const file of files) {
    try {
      hash.update(`${file}\n`);
      hash.update(readFileSync(resolve(repoRoot, file)));
    } catch {
      hash.update(`${file}\n<missing>\n`);
    }
  }
  let gitHead: string | null = null;
  try {
    gitHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    gitHead = null;
  }
  return { gitHead, sourceDigest: hash.digest("hex").slice(0, 16), files };
}

/**
 * Transparent wrapper around the shipped policy. It records the exact
 * `pickRetained` input so the script can ask the *same* policy for the full
 * score map afterwards, and so it knows which candidates were actually kept.
 */
function spyScorePolicy(): {
  policy: RetentionScorePolicy;
  captured: () => { candidates: CanonicalMessage[]; queryHint: string; budgetTokens: number } | undefined;
  kept: () => CanonicalMessage[];
} {
  const base = buildEbbinghausPageRankPolicy();
  let captured: { candidates: CanonicalMessage[]; queryHint: string; budgetTokens: number } | undefined;
  let kept: CanonicalMessage[] = [];
  const policy: RetentionScorePolicy = {
    id: base.id,
    get weights() {
      return base.weights;
    },
    scoreMessages: (input) => base.scoreMessages(input),
    pickRetained: async (input) => {
      captured = {
        candidates: input.candidates,
        queryHint: input.queryHint ?? "",
        budgetTokens: input.retentionBudgetTokens,
      };
      kept = await base.pickRetained(input);
      return kept;
    },
  };
  return { policy, captured: () => captured, kept: () => kept };
}

type Row =
  | { t: "kept"; i: number; role: string; text: string; truncated: boolean; facts: string[] }
  | { t: "retained"; i: number; role: string; text: string; truncated: boolean; facts: string[] }
  | { t: "folded"; i: number; role: string; text: string; truncated: boolean; facts: string[] }
  | { t: "elided"; i0: number; i1: number; n: number };

/**
 * Multiset of visible texts, consumed as messages are matched.
 *
 * Matching by *text* rather than object identity is deliberate: the engine
 * hands the post-compaction context copies of the messages the policy kept
 * (`withHippoRetainedMarker` in `retention/CarryOver.ts` copies so the caller's
 * objects stay untouched). Those copies are what a model actually receives, so
 * text is the right join key; identity would misreport every retained message
 * as folded.
 */
function textCounter(texts: readonly string[]): { take: (text: string) => boolean } {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
  return {
    take(text: string): boolean {
      const remaining = counts.get(text) ?? 0;
      if (remaining <= 0) return false;
      counts.set(text, remaining - 1);
      return true;
    },
  };
}

/**
 * Walk the pre-compaction transcript in its original order and mark every
 * message as kept (the normal retained tail), retained (Hippo's verbatim block,
 * pulled out of the summarize bucket), folded-into-summary, or elided. Fact
 * messages that were folded are emitted as explicit `folded` rows so a reader
 * sees the gap where a fact used to be; runs of non-fact summarized messages
 * collapse into one `elided` row so the page stays readable without hiding them.
 */
function buildRows(
  messages: readonly CanonicalMessage[],
  facts: readonly SyntheticFact[],
  keptTexts: readonly string[],
  retainedTexts: readonly string[],
): Row[] {
  const rows: Row[] = [];
  const retained = textCounter(retainedTexts);
  const kept = textCounter(keptTexts);
  let runStart: number | undefined;
  let runCount = 0;
  const flushRun = () => {
    if (runStart !== undefined && runCount > 0) rows.push({ t: "elided", i0: runStart, i1: runStart + runCount - 1, n: runCount });
    runStart = undefined;
    runCount = 0;
  };
  messages.forEach((message, index) => {
    const text = messageVisibleText(message);
    const markers = factsInText(facts, text);
    if (kept.take(text)) {
      flushRun();
      const shown = preview(text, PREVIEW_CHARS);
      const isRetained = retained.take(text);
      rows.push({
        t: isRetained ? "retained" : "kept",
        i: index,
        role: message.role,
        text: shown.text,
        truncated: shown.truncated,
        facts: markers,
      });
      return;
    }
    if (markers.length > 0) {
      flushRun();
      const shown = preview(text, PREVIEW_CHARS);
      rows.push({ t: "folded", i: index, role: message.role, text: shown.text, truncated: shown.truncated, facts: markers });
      return;
    }
    if (runStart === undefined) runStart = index;
    runCount += 1;
  });
  flushRun();
  return rows;
}

async function main() {
  const transcript = generateTranscript({ numPairs: NUM_PAIRS, seed: SEED, factsCount: FACTS_COUNT });
  const { messages, facts } = transcript;
  if (facts.length !== FACTS_COUNT) {
    throw new Error(`expected ${FACTS_COUNT} injected facts, generator produced ${facts.length}`);
  }

  // --- arm 1: upstream (scorePolicy === undefined) -------------------------
  const upstreamRun = await runEngine(messages, "upstream");
  // --- arm 2: shipped default Hippo policy, same input, same tail budget ---
  const spy = spyScorePolicy();
  const hippoRun = await runEngine(messages, "hippo", spy.policy);

  const captured = spy.captured();
  if (!captured) throw new Error("Hippo arm never called pickRetained; the score policy did not run");
  const scores = await spy.policy.scoreMessages({ candidates: captured.candidates, queryHint: captured.queryHint });
  const keptCandidates = new Set(spy.kept());

  const arms: Record<ArmKey, Record<string, unknown>> = {
    upstream: describeArm("upstream", upstreamRun, messages, facts),
    hippo: describeArm("hippo", hippoRun, messages, facts),
  };

  const factsLedger = facts.map((fact, index) => {
    const text = fact.text;
    const fate = (run: typeof upstreamRun): "verbatim" | "summary-only" | "absent" => {
      const keptText = run.postMessages.map(messageVisibleText).join("\n");
      if (keptText.includes(text)) return "verbatim";
      const summaryText = run.result.summaryMessage ? messageVisibleText(run.result.summaryMessage) : "";
      if (summaryText.includes(text)) return "summary-only";
      return "absent";
    };
    const messageIndex = messages.findIndex((message) => messageVisibleText(message).includes(text));
    return {
      marker: fact.marker,
      value: factValue(fact),
      messageIndex,
      role: messageIndex >= 0 ? messages[messageIndex]!.role : "unknown",
      fate: { upstream: fate(upstreamRun), hippo: fate(hippoRun) },
    };
  });

  const scoredCandidates: ScoredCandidate[] = captured.candidates.map((message) => {
    const index = messages.indexOf(message);
    const text = messageVisibleText(message);
    const shown = preview(text, CANDIDATE_PREVIEW_CHARS);
    return {
      i: index,
      role: message.role,
      text: shown.text,
      truncated: shown.truncated,
      score: round4(scores.get(message) ?? 0),
      retained: keptCandidates.has(message),
      facts: factsInText(facts, text),
    };
  });

  const countFate = (arm: ArmKey, fate: string) => factsLedger.filter((entry) => entry.fate[arm] === fate).length;

  const output = {
    meta: {
      what:
        "Post-compaction context, upstream vs Hippo, on one deterministic synthetic case. " +
        "Same input messages, same fake summarizer, same tail budget; only scorePolicy differs.",
      protocol: "benchmarks/demo/exportContextDiff.ts",
      command: "npx tsx benchmarks/demo/exportContextDiff.ts",
      repo_path_hint: "<repo>/benchmarks/demo/exportContextDiff.ts",
      sourceRevision: sourceRevision(),
      case: { numPairs: NUM_PAIRS, seed: SEED, factsInjected: FACTS_COUNT, language: "en" },
      config: {
        keepTailRatio: KEEP_TAIL_RATIO,
        retentionBudgetRatio: 0.2,
        retentionBudgetFloorTokens: 256,
        summarizer: "engineRunner.fakeModel (fixed-text stub; never emits a fact marker)",
        embedding: "BM25 fallback (no model path configured -> deterministic, offline)",
        scorePolicy: {
          upstream: "undefined (upstream summary-only path)",
          hippo: "buildEbbinghausPageRankPolicy() with shipped default weights",
        },
        weights: {
          wSim: EBBINGHAUS_DEFAULT_WEIGHTS.wSim,
          wTime: EBBINGHAUS_DEFAULT_WEIGHTS.wTime,
          wRank: EBBINGHAUS_DEFAULT_WEIGHTS.wRank,
        },
      },
      honesty: {
        summaryOnlyIsStructural:
          "The fake summarizer never emits FACT text, so 'summary-only' is 0 by construction in both arms. " +
          "Upstream's 0/20 is the lossy-summary-vs-verbatim contrast, not a ceiling on real summarizers.",
        upstreamIsBaseline:
          "The upstream arm is scorePolicy=undefined, which benchmark:no-regression pins byte-for-byte to upstream 85be774.",
      },
    },
    counts: {
      facts: facts.length,
      upstream: {
        verbatim: countFate("upstream", "verbatim"),
        summaryOnly: countFate("upstream", "summary-only"),
        absent: countFate("upstream", "absent"),
      },
      hippo: {
        verbatim: countFate("hippo", "verbatim"),
        summaryOnly: countFate("hippo", "summary-only"),
        absent: countFate("hippo", "absent"),
      },
    },
    arms,
    facts: factsLedger,
    scoring: {
      policyId: spy.policy.id,
      weights: spy.policy.weights,
      queryHint: preview(captured.queryHint, 400).text,
      budgetTokens: captured.budgetTokens,
      candidateCount: scoredCandidates.length,
      retainedCount: scoredCandidates.filter((entry) => entry.retained).length,
      candidates: scoredCandidates,
      note:
        "Candidates are exactly the messages the engine handed to pickRetained. Scores are the shipped " +
        "EbbinghausPageRankPolicy's own output on that input (BM25 similarity + position decay; the PageRank " +
        "term is present in code but weighted 0). 'retained' is what the policy actually kept within the budget.",
    },
  };

  const outPath = resolve(process.env.PILOTDECK_CONTEXT_DIFF_OUT ?? DEFAULT_OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  // ---- stdout summary -----------------------------------------------------
  const up = output.counts.upstream;
  const hp = output.counts.hippo;
  console.log("=== context-diff export (real run, no fabricated numbers) ===");
  console.log(`case            : N=${NUM_PAIRS} pairs, seed=${SEED}, ${FACTS_COUNT} injected facts, keepTailRatio=${KEEP_TAIL_RATIO}`);
  console.log(`preTokens       : ${upstreamRun.result.preTokens}`);
  console.log(`upstream        : postTokens=${upstreamRun.postTokens} kept=${upstreamRun.result.messagesToKeep.length} summarized=${upstreamRun.result.messagesSummarized} facts=${up.verbatim}/${facts.length} verbatim, ${up.summaryOnly} summary-only, ${up.absent} absent, retention=none`);
  console.log(`hippo           : postTokens=${hippoRun.postTokens} kept=${hippoRun.result.messagesToKeep.length} summarized=${hippoRun.result.messagesSummarized} facts=${hp.verbatim}/${facts.length} verbatim, ${hp.summaryOnly} summary-only, ${hp.absent} absent`);
  console.log(`retention       : policy=${hippoRun.result.retention?.policyId ?? "none"} msgs=${hippoRun.result.retention?.retainedMessages ?? 0} tokens=${hippoRun.result.retention?.retainedTokens ?? 0} budget=${hippoRun.result.retention?.budgetTokens ?? captured.budgetTokens}`);
  console.log(`scored          : ${scoredCandidates.length} candidates, ${scoredCandidates.filter((entry) => entry.retained).length} retained`);
  const rowKinds = (arm: ArmKey) => {
    const counts: Record<string, number> = {};
    for (const row of arms[arm]!.rows as Row[]) counts[row.t] = (counts[row.t] ?? 0) + 1;
    return JSON.stringify(counts);
  };
  console.log(`rows upstream   : ${rowKinds("upstream")}`);
  console.log(`rows hippo      : ${rowKinds("hippo")}`);
  console.log(`source revision : ${output.meta.sourceRevision.gitHead ?? "(no git)"} digest=${output.meta.sourceRevision.sourceDigest}`);
  console.log(`deterministic   : no timestamps written; re-run and diff to confirm byte-identical`);
  const misses = factsLedger.filter((entry) => entry.fate.hippo !== "verbatim");
  console.log(`hippo misses    : ${misses.length === 0 ? "(none)" : misses.map((entry) => `${entry.marker}[${entry.fate.hippo}]`).join(", ")}`);
  console.log(`written         : ${outPath}`);
}

function describeArm(
  arm: ArmKey,
  run: Awaited<ReturnType<typeof runEngine>>,
  messages: readonly CanonicalMessage[],
  facts: readonly SyntheticFact[],
): Record<string, unknown> {
  const keptTexts = run.result.messagesToKeep.map(messageVisibleText);
  const retained = run.result.retention;
  const retainedTexts = retained?.retainedMessageTexts ?? [];
  return {
    label: arm === "upstream" ? "上游 (upstream, scorePolicy=undefined)" : "Hippo (shipped default policy)",
    preTokens: run.result.preTokens,
    postTokens: run.postTokens,
    messagesSummarized: run.result.messagesSummarized,
    messagesKept: run.result.messagesToKeep.length,
    boundary: messageVisibleText(run.result.boundaryMarker),
    summary: run.result.summaryMessage ? messageVisibleText(run.result.summaryMessage) : "",
    summaryGenerated: run.result.summaryGenerated === true,
    retention: retained
      ? {
          policyId: retained.policyId,
          retainedMessages: retained.retainedMessages,
          retainedTokens: retained.retainedTokens,
          budgetTokens: retained.budgetTokens,
          weights: retained.weights ?? null,
        }
      : null,
    rows: buildRows(messages, facts, keptTexts, retainedTexts),
  };
}

void main();
