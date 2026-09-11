import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runEngine } from "./engineRunner.js";
import { generateTranscript } from "./syntheticTranscript.js";

const DEFAULT_OUT = join(process.cwd(), "benchmarks", "baseline-85be774.json");

async function main() {
  const writeMode = process.argv.includes("--write-baseline");
  const outputPath = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]!
    : DEFAULT_OUT;
  const transcript = generateTranscript({ numPairs: 48, seed: 20260911 });
  const sample = await runEngine(transcript.messages, "upstream");
  const baseline = {
    upstream85be774: sample.fingerprint,
    preTokens: sample.result.preTokens,
    upstreamPostTokens: sample.postTokens,
    upstreamMessagesSummarized: sample.result.messagesSummarized,
    upstreamMessagesToKeep: sample.result.messagesToKeep.length,
  };

  if (writeMode) {
    writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    console.log("baseline written:", outputPath);
    return;
  }
  if (!existsSync(outputPath)) {
    console.error("Missing baseline; run with --write-baseline against upstream 85be774 first.");
    process.exit(2);
  }

  const expected = JSON.parse(readFileSync(outputPath, "utf8")) as typeof baseline;
  const mismatches: string[] = [];
  if (sample.fingerprint !== expected.upstream85be774) mismatches.push("fingerprint");
  if (sample.result.preTokens !== expected.preTokens) mismatches.push("preTokens");
  if (sample.postTokens !== expected.upstreamPostTokens) mismatches.push("postTokens");
  if (sample.result.messagesSummarized !== expected.upstreamMessagesSummarized) {
    mismatches.push("messagesSummarized");
  }
  if (sample.result.messagesToKeep.length !== expected.upstreamMessagesToKeep) mismatches.push("messagesToKeep");

  if (mismatches.length > 0) {
    console.error(`NO-REGRESSION FAIL: ${mismatches.join(", ")}`);
    console.error(JSON.stringify({ actual: sample, expected }, null, 2));
    process.exit(1);
  }
  console.log("NO-REGRESSION OK: scorePolicy=undefined output matches upstream 85be774 baseline.");
}

void main();
