/**
 * Extraction accuracy of the Hippo score, at message granularity.
 *
 * The README headline "0/20 → 8/9/18" is recall — how many of the 20 facts
 * the query asks to reproduce survive verbatim. It does not say whether the
 * retention block is *mostly the right messages*; a policy could reach the
 * same recall by sweeping in many unrelated messages. This script closes that
 * with precision and compares it to chance.
 *
 * Ground truth: each synthetic fact lives in exactly one user message, in the
 * first ~75% of the conversation, and the tail question asks to reproduce them
 * verbatim. It is measured directly from the engine's own `retention` outcome:
 * `retainedMessageTexts` is exactly what the score kept that reached the
 * prompt, so precision and recall are computed on the same base the existing
 * `retainedMessages` count uses — no reconstruction from the fingerprint.
 *
 *   recall    = retained fact-messages / total fact-messages
 *   precision = retained fact-messages / messages the score kept
 *   baseline  = fact-messages / messages summarizeable (random-retention odds)
 *
 *   pnpm benchmark:extraction   (seeds via PILOTDECK_EVAL_SEEDS)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runEngine } from "./engineRunner.js";
import {
  generateTranscript,
  generateZhTranscript,
  type SyntheticTranscript,
} from "./syntheticTranscript.js";

const SEEDS = Number(process.env.PILOTDECK_EVAL_SEEDS ?? 3);
const SEED_BASE = 20260921; // held-out seeds, never used for tuning
const SIZES = [40, 80, 160] as const;
const LANGS = ["en", "zh"] as const;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
function round(n: number, d = 3): number {
  return Math.round(n * 10 ** d) / 10 ** d;
}

async function measure(transcript: SyntheticTranscript) {
  const hippo = await runEngine(transcript.messages, "hippo");
  const retention = hippo.result.retention;
  const retainedTexts = retention?.retainedMessageTexts ?? [];
  // A retained message is "relevant" if its verbatim text carries a probe fact.
  const factMarkers = transcript.facts.map((fact) => fact.marker);
  const retainedRelevant = retainedTexts.filter((text) =>
    factMarkers.some((marker) => text.includes(marker)),
  ).length;
  return {
    factsRetained: retainedRelevant,
    retainedMessages: retainedTexts.length,
    factsTotal: transcript.facts.length,
    messagesSummarized: hippo.result.messagesSummarized,
    retainedTokens: retention?.retainedTokens ?? 0,
    budgetTokens: retention?.budgetTokens ?? 0,
  };
}

function summarize(
  lang: "en" | "zh",
  size: number,
  rows: Awaited<ReturnType<typeof measure>>[],
) {
  const recallAll = rows.map((r) => r.factsRetained / Math.max(1, r.factsTotal));
  const precisionAll = rows.map((r) =>
    r.retainedMessages > 0 ? r.factsRetained / r.retainedMessages : 0,
  );
  const densityAll = rows.map((r) =>
    r.messagesSummarized > 0 ? r.factsTotal / r.messagesSummarized : 0,
  );
  const budgetUsed = rows.map((r) =>
    r.budgetTokens > 0 ? r.retainedTokens / r.budgetTokens : 0,
  );
  return {
    lang,
    size,
    seeds: rows.length,
    recallMedian: round(median(recallAll)),
    precisionMedian: round(median(precisionAll)),
    chanceBaselineMedian: round(median(densityAll)),
    liftOverChance: round(median(precisionAll) / Math.max(1e-9, median(densityAll)), 1),
    retainedMessagesMedian: Math.round(median(rows.map((r) => r.retainedMessages))),
    factsRetainedMedian: Math.round(median(rows.map((r) => r.factsRetained))),
    budgetUsedRatioMedian: round(median(budgetUsed)),
    factsTotal: rows[0]?.factsTotal ?? 0,
  };
}

async function main() {
  const out: ReturnType<typeof summarize>[] = [];
  for (const lang of LANGS) {
    for (const size of SIZES) {
      const rows: Awaited<ReturnType<typeof measure>>[] = [];
      for (let offset = 0; offset < SEEDS; offset += 1) {
        const seed = SEED_BASE + offset;
        const transcript = lang === "en"
          ? generateTranscript({ numPairs: size, seed })
          : generateZhTranscript({ numPairs: size, seed });
        rows.push(await measure(transcript));
      }
      out.push(summarize(lang, size, rows));
    }
  }

  const resultsDir = resolve(join(process.cwd(), "benchmarks", "results"));
  mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = resolve(resultsDir, `extraction-precision-${timestamp}.json`);
  writeFileSync(
    outputPath,
    `${JSON.stringify({ protocol: "benchmarks/extractionPrecision.ts", timestamp, seedBase: SEED_BASE, seeds: SEEDS, rows: out }, null, 2)}\n`,
    "utf8",
  );

  console.log("Extraction accuracy (message-level, held-out seeds, fake summarizer)");
  console.log("| lang | N | recall | precision | chance baseline | lift× | kept | budget used |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const r of out) {
    console.log(
      `| ${r.lang} | ${r.size} | ${(r.recallMedian * 100).toFixed(1)}% (${r.factsRetainedMedian}/${r.factsTotal}) ` +
        `| ${(r.precisionMedian * 100).toFixed(1)}% | ${(r.chanceBaselineMedian * 100).toFixed(1)}% ` +
        `| ${r.liftOverChance.toFixed(1)}x | ${r.retainedMessagesMedian} | ${(r.budgetUsedRatioMedian * 100).toFixed(0)}% |`,
    );
  }
  console.log("\nresults written:", outputPath);
}

void main();