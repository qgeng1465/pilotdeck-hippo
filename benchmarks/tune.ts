import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildEbbinghausPageRankPolicy } from "../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import { TokenBudgetManager } from "../src/context/budget/TokenBudgetManager.js";
import { messageVisibleText } from "../src/context/compaction/retention/MessageText.js";
import {
  generateTranscript,
  generateZhTranscript,
  type SyntheticTranscript,
} from "./syntheticTranscript.js";

// Fast weight sweep on a reduced protocol (N=80, 3 seeds, EN+ZH) plus a
// no-query robustness probe. The sweep argmax re-anchors the default
// weights; the no-query probe shows what the rank term is for: when no
// pending user request exists the sim term is flat and only graph
// centrality can tell fact-bearing messages from noise.
const SEED_BASE = 20260911;
const SEEDS = 3;
const NUM_PAIRS = 80;

type Config = { key: string; wSim: number; wTime: number; wRank: number };

const GRID: Config[] = [];
for (const wSim of [0.55, 0.7, 0.85]) {
  for (const wTime of [0, 0.15]) {
    for (const wRank of [0, 0.15, 0.3]) {
      const total = wSim + wTime + wRank;
      GRID.push({
        key: `S${wSim}/T${wTime}/R${wRank}`,
        wSim: wSim / total,
        wTime: wTime / total,
        wRank: wRank / total,
      });
    }
  }
}

function countFacts(transcript: SyntheticTranscript, texts: string[]): number {
  const blob = texts.join("\n");
  return transcript.facts.filter((fact) => blob.includes(fact.marker)).length;
}

function candidatesOf(transcript: SyntheticTranscript) {
  // Mirror the engine split: keep the tail (last user request) as query,
  // score the prefix.
  const tailSize = 2;
  return {
    candidates: transcript.messages.slice(0, -tailSize),
    queryHint: messageVisibleText(transcript.messages[transcript.messages.length - 1]!),
  };
}

async function main() {
  const transcripts = new Map<string, SyntheticTranscript[]>();
  for (const lang of ["en", "zh"] as const) {
    transcripts.set(
      lang,
      Array.from({ length: SEEDS }, (_, offset) =>
        lang === "en"
          ? generateTranscript({ numPairs: NUM_PAIRS, seed: SEED_BASE + offset })
          : generateZhTranscript({ numPairs: NUM_PAIRS, seed: SEED_BASE + offset })),
    );
  }

  console.log(`grid=${GRID.length} configs x ${SEEDS} seeds x 2 langs (N=${NUM_PAIRS})\n`);
  const rows: Array<{ key: string; lang: string; facts: number; ms: number }> = [];
  for (const config of GRID) {
    for (const lang of ["en", "zh"] as const) {
      const facts: number[] = [];
      let ms = 0;
      for (const transcript of transcripts.get(lang)!) {
        const { candidates, queryHint } = candidatesOf(transcript);
        const policy = buildEbbinghausPageRankPolicy({
          wSim: config.wSim,
          wTime: config.wTime,
          wRank: config.wRank,
          idfCorrection: true,
        });
        const start = performance.now();
        const retained = await policy.pickRetained({
          candidates,
          retentionBudgetTokens: 520,
          queryHint,
          estimateTokens: (messages) => new TokenBudgetManager().estimateMessagesTokens(messages),
        });
        ms += performance.now() - start;
        facts.push(countFacts(transcript, retained.map(messageVisibleText)));
      }
      const total = facts.reduce((sum, value) => sum + value, 0);
      rows.push({ key: config.key, lang, facts: total, ms: Math.round(ms / facts.length) });
    }
  }

  const byKey = new Map<string, { en: number; zh: number; ms: number }>();
  for (const row of rows) {
    const entry = byKey.get(row.key) ?? { en: 0, zh: 0, ms: 0 };
    if (row.lang === "en") entry.en = row.facts;
    else entry.zh = row.facts;
    entry.ms = Math.max(entry.ms, row.ms);
    byKey.set(row.key, entry);
  }
  const ranked = [...byKey.entries()].sort(
    (a, b) => (b[1].en + b[1].zh) - (a[1].en + a[1].zh),
  );
  console.log("| config (norm.) | EN facts/60 | ZH facts/60 | total | ms/case |");
  console.log("|---|---|---|---|---|");
  for (const [key, value] of ranked) {
    console.log(`| ${key} | ${value.en} | ${value.zh} | ${value.en + value.zh} | ${value.ms} |`);
  }

  // No-query robustness probe: with queryHint="" the BM25 term is flat 0.5,
  // so ranking is decided by time + rank alone.
  console.log("\nno-query probe (queryHint='', budget=520, N=80 x 3 seeds):");
  const noQueryConfigs = [
    { key: "S0.4/T0.35/R0.25+idf (old default)", wSim: 0.4, wTime: 0.35, wRank: 0.25 },
    { key: "S0.7/T0.15/R0.15+idf", wSim: 0.7, wTime: 0.15, wRank: 0.15 },
    { key: "S1/T0/R0 (sim only)", wSim: 1, wTime: 0, wRank: 0 },
    { key: "S0/T0/R1+idf (rank only)", wSim: 0, wTime: 0, wRank: 1 },
  ];
  const noQueryResults: Array<{ config: string; en: number; zh: number; possible: number }> = [];
  for (const config of noQueryConfigs) {
    const line: string[] = [];
    const record = { config: config.key, en: 0, zh: 0, possible: SEEDS * 20 };
    for (const lang of ["en", "zh"] as const) {
      let total = 0;
      for (const transcript of transcripts.get(lang)!) {
        const { candidates } = candidatesOf(transcript);
        const policy = buildEbbinghausPageRankPolicy({
          wSim: config.wSim,
          wTime: config.wTime,
          wRank: config.wRank,
          idfCorrection: true,
        });
        const retained = await policy.pickRetained({
          candidates,
          retentionBudgetTokens: 520,
          queryHint: "",
          estimateTokens: (messages) => new TokenBudgetManager().estimateMessagesTokens(messages),
        });
        total += countFacts(transcript, retained.map(messageVisibleText));
      }
      if (lang === "en") record.en = total;
      else record.zh = total;
      line.push(`${lang}=${total}/${transcripts.get(lang)!.length * 20}`);
    }
    noQueryResults.push(record);
    console.log(`  ${config.key}: ${line.join("  ")}`);
  }

  // Persist the ranking so the weight choice is auditable later: the seed
  // range used here is the *seen* range, and benchmarks/holdout.ts re-tests
  // the chosen default on seeds this sweep never touched.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    protocol: "benchmarks/tune.ts",
    timestamp,
    seedBase: SEED_BASE,
    seeds: SEEDS,
    numPairs: NUM_PAIRS,
    gridSize: GRID.length,
    ranking: ranked.map(([key, value]) => ({
      config: key,
      enFacts: value.en,
      zhFacts: value.zh,
      total: value.en + value.zh,
      msPerCase: value.ms,
    })),
    noQueryProbe: noQueryResults,
  };
  const resultsDir = resolve(join(process.cwd(), "benchmarks", "results"));
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = resolve(resultsDir, `tune-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log("\nresults written:", outputPath);
}

void main();
