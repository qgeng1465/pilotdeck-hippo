import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { runEngine } from "./engineRunner.js";
import {
  buildEbbinghausPageRankPolicy,
  EBBINGHAUS_DEFAULT_WEIGHTS,
} from "../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import {
  generateTranscript,
  generateZhTranscript,
  type SyntheticTranscript,
} from "./syntheticTranscript.js";

type Combo = {
  key: string;
  wSim: number;
  wTime: number;
  wRank: number;
  idfCorrection?: boolean;
};

// Component-wise ablation over the scored retention formula
//   S(m) = wSim*sim + wTime*exp(-lambda*age) + wRank*PageRank(m)
// Each row drops or keeps exactly one term so every component has to
// justify itself against the same transcripts and the same budget.
// The rank-only pair isolates the IDF correction: raw PageRank hubs on
// boilerplate entities, IDF-weighted PageRank hubs on distinctive ones.
const COMBOS: Combo[] = [
  { key: "sim only", wSim: 1, wTime: 0, wRank: 0 },
  { key: "time only", wSim: 0, wTime: 1, wRank: 0 },
  { key: "rank only (raw)", wSim: 0, wTime: 0, wRank: 1, idfCorrection: false },
  { key: "rank only (+idf)", wSim: 0, wTime: 0, wRank: 1, idfCorrection: true },
  { key: "full (old default 0.4/0.35/0.25)", wSim: 0.4, wTime: 0.35, wRank: 0.25, idfCorrection: true },
  { key: "full (default)", wSim: EBBINGHAUS_DEFAULT_WEIGHTS.wSim, wTime: EBBINGHAUS_DEFAULT_WEIGHTS.wTime, wRank: EBBINGHAUS_DEFAULT_WEIGHTS.wRank, idfCorrection: true },
];

const SEED_BASE = 20260911;
const NUM_PAIRS = [40, 80, 160] as const;
const SEEDS = 10;

type Observation = {
  lang: "en" | "zh";
  numPairs: number;
  combo: string;
  factsRetained: number;
  totalFacts: number;
  postTokens: number;
  upstreamPostTokens: number;
  wallMs: number;
  upstreamWallMs: number;
};

function countFacts(transcript: SyntheticTranscript, text: string): number {
  return transcript.facts.filter((fact) => text.includes(fact.marker)).length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function timed<T>(promise: Promise<T>): Promise<{ value: T; wallMs: number }> {
  const start = performance.now();
  return promise.then((value) => ({ value, wallMs: performance.now() - start }));
}

async function main() {
  const observations: Observation[] = [];
  for (const lang of ["en", "zh"] as const) {
    for (const numPairs of NUM_PAIRS) {
      for (let seedOffset = 0; seedOffset < SEEDS; seedOffset += 1) {
        const seed = SEED_BASE + seedOffset;
        const transcript = lang === "en"
          ? generateTranscript({ numPairs, seed })
          : generateZhTranscript({ numPairs, seed });

        const upstream = await timed(runEngine(transcript.messages, "upstream"));

        for (const combo of COMBOS) {
          const policy = buildEbbinghausPageRankPolicy({
            wSim: combo.wSim,
            wTime: combo.wTime,
            wRank: combo.wRank,
            idfCorrection: combo.idfCorrection,
          });
          const hippo = await timed(runEngine(transcript.messages, "hippo", policy));
          observations.push({
            lang,
            numPairs,
            combo: combo.key,
            factsRetained: countFacts(transcript, hippo.value.fingerprint),
            totalFacts: transcript.facts.length,
            postTokens: hippo.value.postTokens,
            upstreamPostTokens: upstream.value.postTokens,
            wallMs: hippo.wallMs,
            upstreamWallMs: upstream.wallMs,
          });
        }
      }
    }
  }

  const groups = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = `${observation.lang}|N=${observation.numPairs}|${observation.combo}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(observation);
    groups.set(key, bucket);
  }

  const rows = [...groups.entries()].map(([key, bucket]) => {
    const [lang, numPairsLabel, combo] = key.split("|");
    const upstreamPostTokens = median(bucket.map((item) => item.upstreamPostTokens));
    return {
      lang,
      numPairs: numPairsLabel,
      combo,
      n: bucket.length,
      factsRetainedMedian: median(bucket.map((item) => item.factsRetained)),
      factsRetainedMean: Math.round(
        bucket.reduce((sum, item) => sum + item.factsRetained, 0) / bucket.length * 100,
      ) / 100,
      totalFacts: bucket[0]!.totalFacts,
      postTokensMedian: Math.round(median(bucket.map((item) => item.postTokens))),
      tokenRatio: Math.round(median(bucket.map((item) => item.postTokens)) / upstreamPostTokens * 100) / 100,
      wallMsMedian: Math.round(median(bucket.map((item) => item.wallMs)) * 10) / 10,
      upstreamWallMsMedian: Math.round(median(bucket.map((item) => item.upstreamWallMs)) * 10) / 10,
    };
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    protocol: "benchmarks/ablation.ts",
    timestamp,
    seedBase: SEED_BASE,
    seeds: SEEDS,
    combos: COMBOS,
    rows,
  };
  const resultsDir = resolve(join(process.cwd(), "benchmarks", "results"));
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = resolve(resultsDir, `ablation-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  const header = "| lang | N | variant | facts retained (median / total) | post tokens | tokens vs upstream | policy wall ms (median) |";
  const rule = "|---|---|---|---|---|---|---|";
  const table = [
    header,
    rule,
    ...rows.map((row) =>
      `| ${row.lang} | ${row.numPairs} | ${row.combo} | ${row.factsRetainedMedian} / ${row.totalFacts} | ${row.postTokensMedian} | ${row.tokenRatio}x | ${row.wallMsMedian} |`
    ),
  ].join("\n");
  console.log(table);
  console.log("\nresults written:", outputPath);
}

void main();
