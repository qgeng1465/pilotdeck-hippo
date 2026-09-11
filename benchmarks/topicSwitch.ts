import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPostCompactMessages, CompactionEngine } from "../src/context/compaction/CompactionEngine.js";
import { TokenBudgetManager } from "../src/context/budget/TokenBudgetManager.js";
import { messageVisibleText } from "../src/context/compaction/retention/MessageText.js";
import { buildEbbinghausPageRankPolicy } from "../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import { fakeModel } from "./engineRunner.js";
import type { CanonicalMessage } from "../src/model/index.js";

// What happens to the context when the user changes topic mid-conversation?
//
// Both upstream compaction and Hippo's scoring are *query-conditioned*: the
// tail is treated as "what the user currently wants". After a topic switch
// that tail describes the NEW topic, so anything scored by similarity to it
// is biased toward the new topic and away from the old one. This benchmark
// measures exactly that asymmetry instead of assuming it away:
//
//   * topic A facts   -> injected early, then abandoned (the "old" topic)
//   * topic B facts   -> injected late, and the pending request is about B
//
// It reports how many facts of each topic survive verbatim into the
// post-compaction context, for upstream vs Hippo, and — the point of the
// whole exercise — how many survive *nowhere* (neither verbatim nor in the
// summary). "Survives nowhere" is the number that would justify saying
// compaction lost information, and it is why the transcript itself is
// append-only: what is dropped here is dropped from the *prompt*, not from
// the record.

const TOPIC_A_GENES = ["TP53", "CTNNB1", "ARID1A", "AXIN1", "BAP1", "TERT", "RB1"];
const TOPIC_B_GENES = ["BRCA1", "BRCA2", "PALB2", "ATM", "CHEK2", "RAD51C", "MLH1"];

const NOISE = [
  "Recheck the staging manifest and reconcile the row order before the next step.",
  "Recompute the fold split with the fixed seed and write it to the staging directory.",
  "Confirm the covariate table matches the matrix row order; remap if it drifted.",
  "Trim the low-confidence records and regenerate the summary table.",
  "Refresh the cached counts after the latest genotype call and rebuild the index.",
];

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

export type TopicFact = { marker: string; text: string; messageIndex: number };

/**
 * How the two topics' facts are worded.
 *
 * `shared` is the original form: both topics write their facts with one schema
 * (`cohort=… n=371 gene=… freq=… stat=…`), and the pending request uses that same
 * schema's words. That shared shape is a lexical bridge between a question about
 * B and the facts of A, so the topic A column partly measures our own wording —
 * `benchmark:topic-diagnosis` puts about 78% of A's advantage over filler on it.
 *
 * `decorrelated` gives each topic its own field vocabulary and its own marker
 * word, and phrases the request in B's words only. Topic is then the sole thing
 * separating an A fact from the request, which is what the table claims to
 * measure. Both are reported so the difference stays visible.
 */
export type FactStyle = "shared" | "decorrelated";

/** The pending request at the end of the transcript: it is about topic B. */
export const TOPIC_SWITCH_QUERIES: Record<FactStyle, string> = {
  shared: "Now answer the TCGA-BRCA gene frequency questions from the exact values recorded above.",
  decorrelated: "Now answer the breast marker questions from the recorded numbers.",
};

/** Back-compat alias for the original style. */
export const TOPIC_SWITCH_QUERY = TOPIC_SWITCH_QUERIES.shared;

function factText(options: {
  style: FactStyle;
  topic: "A" | "B";
  marker: string;
  gene: string;
  freq: string;
  stat: string;
}): string {
  const { style, topic, marker, gene, freq, stat } = options;
  if (style === "shared") {
    return `${marker}: cohort=${topic === "A" ? "TCGA-LIHC" : "TCGA-BRCA"} n=371 gene=${gene} freq=${freq} stat=${stat}`;
  }
  // Disjoint vocabularies: nothing here appears in both topics, and only B's
  // words appear in the request.
  return topic === "A"
    ? `${marker}: liver amplicon ${gene} reading ${freq} dispersion ${stat}`
    : `${marker}: breast marker ${gene} value ${freq} spread ${stat}`;
}

export function buildTranscript(options: {
  seed: number;
  pairsPerTopic: number;
  factsPerTopic: number;
  factStyle?: FactStyle;
}): { messages: CanonicalMessage[]; factsA: TopicFact[]; factsB: TopicFact[] } {
  const style = options.factStyle ?? "shared";
  const random = mulberry32(options.seed);
  const messages: CanonicalMessage[] = [];
  const factsA: TopicFact[] = [];
  const factsB: TopicFact[] = [];

  const build = (topic: "A" | "B", pairs: number, factsPerTopic: number) => {
    const genes = topic === "A" ? TOPIC_A_GENES : TOPIC_B_GENES;
    const facts = topic === "A" ? factsA : factsB;
    const spacing = Math.max(1, Math.floor(pairs / factsPerTopic));
    for (let index = 0; index < pairs; index += 1) {
      const shouldInject = index % spacing === 0 && facts.length < factsPerTopic;
      let userText: string;
      if (shouldInject) {
        // The marker is part of the scored text, so it must not be a bridge
        // either: the two topics get different marker words.
        const marker = style === "shared"
          ? `${topic}-FACT${facts.length + 1}`
          : topic === "A"
            ? `A-RUN${facts.length + 1}`
            : `B-MARK${facts.length + 1}`;
        const gene = genes[Math.floor(random() * genes.length)]!;
        const freq = ((Math.floor(random() * 90) + 5) / 100).toFixed(3);
        const stat = (Math.round((random() * 3.5 + 0.1) * 100) / 100).toFixed(2);
        const text = factText({ style, topic, marker, gene, freq, stat });
        facts.push({ marker, text, messageIndex: messages.length });
        userText = `${text} Record this exact value as a checkpoint.`;
      } else {
        userText = `${NOISE[Math.floor(random() * NOISE.length)]} step=${index + 1} metric=${Math.floor(random() * 9000 + 1000)}`;
      }
      messages.push({ role: "user", content: [{ type: "text", text: userText }] });
      messages.push({ role: "assistant", content: [{ type: "text", text: `Acknowledged. reply=${Math.floor(random() * 100000)}` }] });
    }
  };

  build("A", options.pairsPerTopic, options.factsPerTopic);
  // The topic switch: an explicit pivot, then topic B runs to the end.
  messages.push({
    role: "user",
    content: [{ type: "text", text: "Let's switch topics. Forget the liver cohort for now — new task on the breast cohort." }],
  });
  build("B", options.pairsPerTopic, options.factsPerTopic);

  messages.push({
    role: "user",
    content: [{ type: "text", text: TOPIC_SWITCH_QUERIES[style] }],
  });

  return { messages, factsA, factsB };
}

function markersIn(facts: TopicFact[], text: string): Set<string> {
  return new Set(facts.filter((fact) => text.includes(fact.marker)).map((fact) => fact.marker));
}

async function runVariant(messages: CanonicalMessage[], withHippo: boolean) {
  const engine = new CompactionEngine({
    model: fakeModel,
    provider: "benchmark",
    model_: "benchmark-summarizer",
    maxOutputTokens: 1200,
    scorePolicy: withHippo ? buildEbbinghausPageRankPolicy() : undefined,
  });
  const result = await engine.run({
    trigger: "auto",
    messages,
    keepTailRatio: 0.18,
    protectedToolNames: null,
  });
  const postMessages = buildPostCompactMessages(result);
  const postTokens = result.postTokens ?? new TokenBudgetManager().estimateMessagesTokens(postMessages);
  // Two different texts: what survives verbatim, and what is still reachable
  // at all (verbatim + the summary the model will actually read).
  const verbatimText = postMessages.map(messageVisibleText).join("\n");
  return { result, verbatimText, postTokens };
}

async function main() {
  const SEED_BASE = 20260921;
  const SEEDS = 10;
  const PAIRS_PER_TOPIC = [80, 160] as const;
  const FACTS_PER_TOPIC = 10;

  console.log(
    `topic-switch protocol: ${SEEDS} held-out seeds (${SEED_BASE}..${SEED_BASE + SEEDS - 1}), ` +
      `${FACTS_PER_TOPIC} facts/topic, facts/case=${FACTS_PER_TOPIC * 2}\n`,
  );

  type Row = {
    factStyle: FactStyle;
    numPairsPerTopic: number;
    variant: "upstream" | "hippo";
    aVerbatimMean: number;
    bVerbatimMean: number;
    aInSummaryOnly: number;
    bInSummaryOnly: number;
    postTokensMean: number;
  };
  const rows: Row[] = [];
  const styles: FactStyle[] = ["shared", "decorrelated"];

  console.log("### Facts surviving into the post-compaction prompt (mean of 10 seeds, out of 10/topic)\n");
  console.log("`shared` is the original wording; `decorrelated` gives each topic its own vocabulary,");
  console.log("so similarity cannot ride on the sentence shape. The gap between the two is the artifact.\n");
  console.log("| N/topic | fact wording | variant | topic A verbatim (old) | topic B verbatim (new) | A summary-only | B summary-only | post tokens |");
  console.log("|---|---|---|---:|---:|---:|---:|---:|");

  for (const factStyle of styles) {
  for (const numPairsPerTopic of PAIRS_PER_TOPIC) {
    const cases = Array.from({ length: SEEDS }, (_, offset) =>
      buildTranscript({ seed: SEED_BASE + offset, pairsPerTopic: numPairsPerTopic, factsPerTopic: FACTS_PER_TOPIC, factStyle }),
    );
    for (const withHippo of [false, true]) {
      let aVerbatim = 0;
      let bVerbatim = 0;
      let aOnly = 0;
      let bOnly = 0;
      let tokens = 0;
      for (const testCase of cases) {
        const run = await runVariant(testCase.messages, withHippo);
        const summaryText = run.result.summaryMessage ? messageVisibleText(run.result.summaryMessage) : "";
        const aVerbatimMarkers = markersIn(testCase.factsA, run.verbatimText);
        const bVerbatimMarkers = markersIn(testCase.factsB, run.verbatimText);
        aVerbatim += aVerbatimMarkers.size;
        bVerbatim += bVerbatimMarkers.size;
        // Facts reachable ONLY as paraphrase: in the summary, not verbatim.
        // (Facts in neither are gone from the prompt entirely — the category
        // that would justify calling this information loss.)
        for (const marker of markersIn(testCase.factsA, summaryText)) {
          if (!aVerbatimMarkers.has(marker)) aOnly += 1;
        }
        for (const marker of markersIn(testCase.factsB, summaryText)) {
          if (!bVerbatimMarkers.has(marker)) bOnly += 1;
        }
        tokens += run.postTokens;
      }
      const row: Row = {
        factStyle,
        numPairsPerTopic,
        variant: withHippo ? "hippo" : "upstream",
        aVerbatimMean: Math.round((aVerbatim / SEEDS) * 100) / 100,
        bVerbatimMean: Math.round((bVerbatim / SEEDS) * 100) / 100,
        aInSummaryOnly: Math.round((aOnly / SEEDS) * 100) / 100,
        bInSummaryOnly: Math.round((bOnly / SEEDS) * 100) / 100,
        postTokensMean: Math.round(tokens / SEEDS),
      };
      rows.push(row);
      console.log(
        `| ${numPairsPerTopic} | ${factStyle} | ${row.variant} | ${row.aVerbatimMean} | ${row.bVerbatimMean} | ${row.aInSummaryOnly} | ${row.bInSummaryOnly} | ${row.postTokensMean} |`,
      );
    }
  }
  }

  console.log(
    "\nReading: the pending request is about topic B, so every query-conditioned\n" +
      "term favours B. Compare the two fact-wording blocks before quoting the\n" +
      "topic A column: at the default weights wRank is 0, so the entity graph\n" +
      "scores nothing, and `benchmark:topic-diagnosis` shows recency-only also\n" +
      "keeps 0/10. What retains A under `shared` is lexical similarity riding on\n" +
      "one wording template; `decorrelated` removes that bridge and is the\n" +
      "honest estimate of topic-independent retention.\n" +
      "`summary-only` counts facts that exist in the prompt ONLY as paraphrase.\n" +
      "\nCaveat: this harness uses a fixed-text stub summarizer, so the summary\n" +
      "never carries a fact by construction — 'summary-only' is 0 for both arms\n" +
      "and the verbatim column is the whole story here. End-to-end\n" +
      "answerability under a real summarizer is a different measurement, made\n" +
      "by `benchmark:real-llm-topic-switch` (which also has a 'from summary'\n" +
      "column this table structurally cannot produce), not by this one.",
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    protocol: "benchmarks/topicSwitch.ts",
    timestamp,
    seedBase: SEED_BASE,
    seeds: SEEDS,
    factsPerTopic: FACTS_PER_TOPIC,
    rows,
  };
  const resultsDir = resolve(join(process.cwd(), "benchmarks", "results"));
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = resolve(resultsDir, `topic-switch-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log("\nresults written:", outputPath);
}

// `benchmarks/topicDiagnosis.ts` imports the transcript builder from this file,
// so main() must not fire on import — otherwise a diagnosis run would also
// re-execute this whole benchmark and write a second results file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
