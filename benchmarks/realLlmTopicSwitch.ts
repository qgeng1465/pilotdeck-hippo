import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPostCompactMessages, CompactionEngine } from "../src/context/compaction/CompactionEngine.js";
import { TokenBudgetManager } from "../src/context/budget/TokenBudgetManager.js";
import { messageVisibleText } from "../src/context/compaction/retention/MessageText.js";
import { buildEbbinghausPageRankPolicy } from "../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import { buildTranscript, type FactStyle, type TopicFact } from "./topicSwitch.js";
import { factPresent } from "./factPresent.js";
import type { CanonicalMessage } from "../src/model/index.js";
import {
  chat,
  configureEndpoint,
  createRealModel,
  loadEndpoint,
  median,
  MODEL,
} from "./realLlmClient.js";

// Does a REAL summarizer change the topic-switch story?
//
// `benchmark:topic-switch` answers a narrower question than its name suggests:
// it uses a fixed-text stub summarizer, so the summary cannot carry a fact by
// construction and the verbatim column is the whole result. README §4.6 flags
// that as a gap — "can the user still answer questions about the old topic?"
// needs a summarizer that could plausibly have kept the old facts.
//
// This benchmark runs that experiment and, importantly, does not flatter the
// fork:
//
//   * A real summarizer DOES carry the abandoned topic, on its own. It copies
//     checkpoint lines into its own summary — upstream, which has no retention
//     block to begin with, answers topic A questions just as well. "The fork is
//     what remembers the old topic" is therefore false under a capable
//     summarizer, and this file is the evidence for saying so.
//   * Measured over repeats, the same-configuration spread decides what may be
//     read as a direction. `PILOTDECK_EVAL_REPEATS` exists to make that spread
//     visible: a single pass of this benchmark looks like a clean win and is
//     not one. At the shipped default (a loose summary budget) the spread is
//     larger than any between-arm difference, so nothing is claimed. At a
//     binding budget (`PILOTDECK_EVAL_SUMMARY_TOKENS=1500`) the current-task
//     gap is three times the spread and repeats in both wordings — that is the
//     one condition §4.7 states a direction for.
//
// Splitting "the marker is in the prompt" into body vs summary-only is what
// makes the mechanism readable, because the post-compaction text includes the
// summary. Topic A carries that split on its own:
//
//   * Topic A sits at the start of the transcript, far outside the kept tail.
//     Both upstream arms — which have no retention block — score 0 in body on
//     topic A, which is the measurement behind that claim rather than an
//     assumption about the tail. So for topic A, "in body" can only mean the
//     retention block kept it, and "in summary only" can only mean the
//     summarizer wrote it down itself.
//   * Consequence worth keeping: the shared-wording artifact §4.6 diagnoses
//     (similarity bridging two identical sentence templates) reappears here as
//     a body count under `shared` and disappears under `decorrelated`, so the
//     real-summarizer path reproduces the stub-harness artifact instead of
//     contradicting it.
//
// One bookkeeping rule learned the hard way: a row with zero parsed questions
// prints as "0%" and reads like a result. The `decorrelated` wording has its
// own field names, and reading only the shared ones silently produced exactly
// such a row. Parsing is now style-aware and a zero-question row aborts the run.

// Overridable so the harness itself can be smoke-tested on a fraction of the
// quota; the values actually used are recorded in the results JSON.
const SEED_BASE = 20260921;
const SEEDS = Number(process.env.PILOTDECK_EVAL_SEEDS ?? 2);
const REPEATS = Number(process.env.PILOTDECK_EVAL_REPEATS ?? 2);
const PAIRS_PER_TOPIC = Number(process.env.PILOTDECK_EVAL_PAIRS ?? 160);
const FACTS_PER_TOPIC = 10;
const QUESTIONS_PER_TOPIC = 4;

// A summary cut off by the output limit looks like a bad summarizer for a
// reason that has nothing to do with compaction policy, which would bias the
// comparison toward the fork. 4000 truncated every case; 8000 does not, and
// the count is reported per row either way.
const SUMMARY_TOKENS = Number(process.env.PILOTDECK_EVAL_SUMMARY_TOKENS ?? 8000);

type Variant = "upstream" | "hippo";
type Topic = "A" | "B";

export type FactView = { gene: string; label1: string; label2: string; value1: string; value2: string };

/**
 * One fact, read in whichever wording the harness used for it.
 *
 * The `shared` wording carries `gene=… freq=… stat=…`; `decorrelated` gives
 * each topic its own field names on purpose, because that is what removes the
 * lexical bridge between the two topics.
 */
export function viewOf(factStyle: FactStyle, topic: Topic, fact: TopicFact): FactView | null {
  if (factStyle === "shared") {
    const match = /gene=(\S+)\s+freq=([\d.]+)\s+stat=([\d.]+)/.exec(fact.text);
    return match
      ? { gene: match[1]!, label1: "freq", value1: match[2]!, label2: "stat", value2: match[3]! }
      : null;
  }
  const match = topic === "A"
    ? /amplicon (\S+) reading ([\d.]+) dispersion ([\d.]+)/.exec(fact.text)
    : /marker (\S+) value ([\d.]+) spread ([\d.]+)/.exec(fact.text);
  const labels = topic === "A" ? ["reading", "dispersion"] : ["value", "spread"];
  return match
    ? { gene: match[1]!, label1: labels[0]!, value1: match[2]!, label2: labels[1]!, value2: match[3]! }
    : null;
}

/** Same question shape as realLlmEval.ts for the `shared` wording, so they are comparable. */
export function questionFor(fact: TopicFact, view: FactView): string {
  return `From the conversation context, report checkpoint ${fact.marker}: which gene does it involve, and what are the exact ${view.label1} and ${view.label2} values recorded for it? Answer in exactly this format and nothing else: gene=<gene> ${view.label1}=<value> ${view.label2}=<value>`;
}

/** Strict label match: the right numbers under the wrong field names are not a correct answer. */
export function gradeView(answer: string, view: FactView): boolean {
  const pattern = new RegExp(
    `gene=([A-Za-z0-9._-]+)\\s+${view.label1}=([\\d.]+)\\s+${view.label2}=([\\d.]+)`,
  );
  const match = pattern.exec(answer);
  if (!match) return false;
  return match[1]!.toUpperCase() === view.gene.toUpperCase()
    && Math.abs(Number.parseFloat(match[2]!) - Number.parseFloat(view.value1)) < 1e-6
    && Math.abs(Number.parseFloat(match[3]!) - Number.parseFloat(view.value2)) < 1e-6;
}

/** Evenly spaced pick across the topic's facts, so we do not sample one end. */
function pickFacts(facts: TopicFact[]): TopicFact[] {
  const count = Math.min(QUESTIONS_PER_TOPIC, facts.length);
  const picked: TopicFact[] = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(facts[Math.round((index * (facts.length - 1)) / Math.max(1, count - 1))]!);
  }
  return picked;
}

async function runVariant(messages: CanonicalMessage[], variant: Variant, apiKey: string) {
  const real = createRealModel(apiKey);
  const engine = new CompactionEngine({
    model: real.model,
    provider: "benchmark",
    model_: MODEL,
    maxOutputTokens: SUMMARY_TOKENS,
    scorePolicy: variant === "hippo" ? buildEbbinghausPageRankPolicy() : undefined,
  });
  const result = await engine.run({
    trigger: "auto",
    messages,
    keepTailRatio: 0.18,
    protectedToolNames: null,
  });
  const postMessages = buildPostCompactMessages(result);
  // The summary is itself one of these messages; separating it lets us say
  // where a marker was found instead of only whether it was found.
  const summaryText = result.summaryMessage ? messageVisibleText(result.summaryMessage) : "";
  const bodyText = postMessages
    .filter((message) => message !== result.summaryMessage)
    .map(messageVisibleText)
    .join("\n");
  return {
    summaryText,
    bodyText,
    postTokens: result.postTokens ?? new TokenBudgetManager().estimateMessagesTokens(postMessages),
    summaryMs: real.wallMs.length > 0 ? real.wallMs.reduce((a, b) => a + b, 0) / real.wallMs.length : 0,
    usage: real.usage,
    summaryTruncated: real.finishReasons.filter((reason) => reason !== "stop").length,
  };
}

type Counts = { asked: number; correct: number; markerInBody: number; markerInSummaryOnly: number };
const emptyCounts = (): Counts => ({ asked: 0, correct: 0, markerInBody: 0, markerInSummaryOnly: 0 });

type Row = {
  factStyle: FactStyle;
  variant: Variant;
  perRepeat: Record<Topic, Counts[]>;
  postTokens: number[];
  summaryMs: number[];
  summaryTruncated: number;
  cases: number;
  promptTokens: number;
  completionTokens: number;
  judgePromptTokens: number;
};

async function main() {
  const endpoint = loadEndpoint();
  configureEndpoint(endpoint.url);
  const apiKey = endpoint.apiKey;
  console.log(
    `real-LLM topic-switch: model=${MODEL}, endpoint=${endpoint.url} [${endpoint.source}]\n` +
      `${SEEDS} held-out seeds x ${REPEATS} repeats, N/topic=${PAIRS_PER_TOPIC}, ` +
      `${FACTS_PER_TOPIC} facts/topic, questions=${QUESTIONS_PER_TOPIC}/topic/case\n`,
  );

  const rows = new Map<string, Row>();
  const rowFor = (factStyle: FactStyle, variant: Variant): Row => {
    const key = `${factStyle}|${variant}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        factStyle,
        variant,
        perRepeat: { A: [], B: [] },
        postTokens: [],
        summaryMs: [],
        summaryTruncated: 0,
        cases: 0,
        promptTokens: 0,
        completionTokens: 0,
        judgePromptTokens: 0,
      };
      rows.set(key, row);
    }
    return row;
  };

  // Both wordings, for the reason §4.6 reports both: under `shared` the two
  // topics' facts share one sentence template, so the old-topic column partly
  // measures the harness rather than the policy.
  const styles: FactStyle[] = ["shared", "decorrelated"];
  for (const factStyle of styles) {
    console.log(`--- fact wording: ${factStyle} ---`);
    for (const variant of ["upstream", "hippo"] as const) {
      const row = rowFor(factStyle, variant);
      for (let repeat = 0; repeat < REPEATS; repeat += 1) {
        const counts: Record<Topic, Counts> = { A: emptyCounts(), B: emptyCounts() };
        for (let seedOffset = 0; seedOffset < SEEDS; seedOffset += 1) {
          const seed = SEED_BASE + seedOffset;
          const testCase = buildTranscript({
            seed,
            pairsPerTopic: PAIRS_PER_TOPIC,
            factsPerTopic: FACTS_PER_TOPIC,
            factStyle,
          });
          const asked: Array<{ topic: Topic; fact: TopicFact; view: FactView }> = [];
          for (const topic of ["A", "B"] as const) {
            const source = topic === "A" ? testCase.factsA : testCase.factsB;
            for (const fact of pickFacts(source)) {
              const view = viewOf(factStyle, topic, fact);
              if (!view) {
                // A fact this file cannot read is a harness/scraper mismatch,
                // not a measurement. Fail loudly rather than score it wrong.
                throw new Error(`unparsable ${factStyle} topic ${topic} fact: ${fact.text}`);
              }
              asked.push({ topic, fact, view });
            }
          }

          const outcome = await runVariant(testCase.messages, variant, apiKey);
          row.postTokens.push(outcome.postTokens);
          row.summaryMs.push(outcome.summaryMs);
          row.summaryTruncated += outcome.summaryTruncated;
          row.cases += 1;
          row.promptTokens += outcome.usage.promptTokens;
          row.completionTokens += outcome.usage.completionTokens;

          for (const { topic, fact, view } of asked) {
            const judge = await chat(apiKey, [
              {
                role: "system",
                content:
                  "You answer questions strictly from the provided conversation context. If the context lacks the answer, reply exactly: NOT_IN_CONTEXT",
              },
              {
                role: "user",
                content: `<conversation>\n${outcome.summaryText}\n${outcome.bodyText}\n</conversation>\n\n${questionFor(fact, view)}`,
              },
            ], { maxTokens: 700 });
            row.judgePromptTokens += judge.usage.promptTokens;
            const stat = counts[topic];
            stat.asked += 1;
            if (gradeView(judge.text, view)) stat.correct += 1;
            if (factPresent(outcome.bodyText, fact.marker)) stat.markerInBody += 1;
            else if (factPresent(outcome.summaryText, fact.marker)) stat.markerInSummaryOnly += 1;
          }
        }
        row.perRepeat.A.push(counts.A);
        row.perRepeat.B.push(counts.B);
        console.log(
          `  repeat ${repeat + 1}/${REPEATS} ${factStyle} ${variant}: ` +
            `A ${counts.A.correct}/${counts.A.asked}, B ${counts.B.correct}/${counts.B.asked}` +
            (row.summaryTruncated > 0 ? ` summaryTruncated=${row.summaryTruncated}` : ""),
        );
      }
    }
  }

  // A row with no questions is a harness bug, and it would otherwise print as
  // "0%" — look like a result, and get quoted. Refuse to produce the table.
  for (const [key, row] of rows) {
    for (const topic of ["A", "B"] as const) {
      for (const counts of row.perRepeat[topic]) {
        if (counts.asked === 0) {
          throw new Error(`no questions asked for ${key} topic ${topic} — refusing to print a 0% that is not a measurement`);
        }
      }
    }
  }

  const total = (row: Row, topic: Topic) =>
    row.perRepeat[topic].reduce(
      (acc, counts) => ({
        asked: acc.asked + counts.asked,
        correct: acc.correct + counts.correct,
        markerInBody: acc.markerInBody + counts.markerInBody,
        markerInSummaryOnly: acc.markerInSummaryOnly + counts.markerInSummaryOnly,
      }),
      emptyCounts(),
    );
  const spread = (row: Row, topic: Topic) => row.perRepeat[topic].map((counts) => counts.correct);

  console.log("\n### Answerability with only the post-compaction context (real summarizer)\n");
  console.log("`marker in body` = the checkpoint's marker text is in the retained messages (not the summary).");
  console.log("`marker in summary only` = the marker appears ONLY inside the model's summary — i.e. the summarizer\n");
  console.log("copied the checkpoint itself. The post-compaction prompt contains both, so an answer can come from either.\n");
  console.log("| fact wording | variant | topic | repeats (answered/asked) | total | marker in body (of 10, median) | marker in summary only |");
  console.log("|---|---|---|---|---:|---:|---:|");
  for (const factStyle of styles) {
    for (const variant of ["upstream", "hippo"] as const) {
      const row = rowFor(factStyle, variant);
      for (const topic of ["A", "B"] as const) {
        const sum = total(row, topic);
        const perRepeat = row.perRepeat[topic].map((c) => `${c.correct}/${c.asked}`).join(", ");
        const body = median(row.perRepeat[topic].map((c) => c.markerInBody));
        const summaryOnly = median(row.perRepeat[topic].map((c) => c.markerInSummaryOnly));
        console.log(
          `| ${factStyle} | ${variant} | ${topic}${topic === "A" ? " (abandoned)" : " (current)"} | ${perRepeat} | ` +
            `${sum.correct}/${sum.asked} | ${body} | ${summaryOnly} |`,
        );
      }
    }
  }

  console.log(
    "\nReading, in the order the evidence supports it:\n" +
      "1. Read the mechanism columns first, and read them against the upstream\n" +
      "   arms. Both upstream arms are 0 in body on topic A (they have no\n" +
      "   retention block, and topic A is far outside the kept tail), so on topic\n" +
      "   A 'in body' is the retention block and 'in summary only' is the\n" +
      "   summarizer writing the checkpoint down itself.\n" +
      "2. The summarizer carries the abandoned topic on its own. Upstream under\n" +
      "   `decorrelated` puts topic A markers in the prompt only via its summary,\n" +
      "   and still answers every topic A question. 'The old topic is still\n" +
      "   answerable' is therefore not evidence of this fork's memory — check the\n" +
      "   body column before claiming anything of the sort.\n" +
      "3. The `shared` body count on topic A is the §4.6 artifact reappearing: it\n" +
      "   is nonzero under `shared` and zero under `decorrelated` for the fork,\n" +
      "   and zero for upstream either way. The real-summarizer path reproduces\n" +
      "   the stub harness's finding instead of contradicting it.\n" +
      "4. Topic B is the pending request: the kept tail and the summary both\n" +
      "   cover the recent end. At the shipped budget every arm answers it and\n" +
      "   the row is a sanity check, not a result. Lower the summary budget until\n" +
      "   it binds and this is where the fork separates from upstream — see\n" +
      "   PILOTDECK_EVAL_SUMMARY_TOKENS and README §4.7.\n" +
      "5. Compare the repeats column before comparing the arms. Same settings,\n" +
      "   same seeds: if the per-repeat counts move by more than the between-arm\n" +
      "   gap, the gap is not measurable at this sample size, and no directional\n" +
      "   claim should be taken from this table. At the shipped budget that is\n" +
      "   exactly what happens (and §4.3 reaches the same conclusion for the\n" +
      "   single-topic transcripts); at a binding budget the gap is larger than\n" +
      "   the spread, which is the one case §4.7 reads as a direction.",
  );

  const summary = [...rows.values()].map((row) => ({
    factStyle: row.factStyle,
    variant: row.variant,
    repeats: REPEATS,
    seeds: SEEDS,
    topicA: { ...total(row, "A"), perRepeatCorrect: spread(row, "A") },
    topicB: { ...total(row, "B"), perRepeatCorrect: spread(row, "B") },
    postTokensMedian: Math.round(median(row.postTokens)),
    summaryWallMsMedian: Math.round(median(row.summaryMs)),
    summaryTruncated: row.summaryTruncated,
    cases: row.cases,
    summarizerPromptTokens: row.promptTokens,
    summarizerCompletionTokens: row.completionTokens,
    judgePromptTokens: row.judgePromptTokens,
  }));

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    protocol: "benchmarks/realLlmTopicSwitch.ts",
    model: MODEL,
    endpoint: endpoint.source,
    timestamp,
    seedBase: SEED_BASE,
    seeds: SEEDS,
    repeats: REPEATS,
    pairsPerTopic: PAIRS_PER_TOPIC,
    factsPerTopic: FACTS_PER_TOPIC,
    questionsPerTopic: QUESTIONS_PER_TOPIC,
    summaryOutputTokens: SUMMARY_TOKENS,
    summary,
  };
  const resultsDir = resolve(join(process.cwd(), "benchmarks", "results"));
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = resolve(resultsDir, `real-llm-topic-switch-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log("\nresults written:", outputPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
