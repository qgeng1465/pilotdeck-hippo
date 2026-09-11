import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCase, type CaseMetrics } from "./abHarness.js";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function summarize(name: string, cases: CaseMetrics[]) {
  return {
    name,
    n: cases.length,
    preTokensMedian: Math.round(median(cases.map((item) => item.preTokens))),
    upstreamPostTokensMedian: Math.round(median(cases.map((item) => item.upstream.postTokens))),
    hippoPostTokensMedian: Math.round(median(cases.map((item) => item.hippo.postTokens))),
    postReductionMedianPercent: Math.round(
      median(cases.map((item) => item.upstream.postTokens > 0
        ? ((item.upstream.postTokens - item.hippo.postTokens) / item.upstream.postTokens) * 100
        : 0)) * 10,
    ) / 10,
    upstreamFactsRetainedMedian: median(cases.map((item) => item.upstream.factsRetained)),
    hippoFactsRetainedMedian: median(cases.map((item) => item.hippo.factsRetained)),
    factsRetentionGainMedian: median(cases.map((item) => item.factsRatio)),
    deterministicHippo: cases.every((item) => item.hippo.deterministic),
  };
}

async function main() {
  const seedBase = 20260911;
  const runs: CaseMetrics[] = [];
  for (const numPairs of [40, 80, 160]) {
    for (let seedOffset = 0; seedOffset < 10; seedOffset += 1) {
      runs.push(await runCase(numPairs, seedBase + seedOffset));
    }
  }
  const groups = [40, 80, 160].map((numPairs) => ({
    ...summarize(`N=${numPairs}`, runs.filter((item) => item.numPairs === numPairs)),
  }));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    protocol: "README.md#本仓库的增量改造hippo-海马记忆",
    timestamp,
    seedBase,
    scorePolicy: "ebbinghaus-pagerank",
    embedding: "bm25-fallback (transformers optional)",
    deterministic: runs.every((item) => item.hippo.deterministic),
    allCasesDeterministic: runs.every((item) => item.hippo.deterministic),
    groups,
    cases: runs,
  };
  const resultsDir = resolve(join(process.cwd(), "benchmarks", "results"));
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = resolve(resultsDir, `${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output.groups, null, 2));
  console.log("results written:", outputPath);
}

void main();
