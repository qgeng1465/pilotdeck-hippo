/**
 * Scaling of the two token counters behind `countTokens`.
 *
 * README §5.1 quotes a table of wall-clock times for a single repeated
 * character, and the whole point of that table is that the library's merge is
 * quadratic while ours is not. A number like that is only worth printing if a
 * reader can regenerate it, so this script is the source of that table: it
 * measures both implementations on the same inputs and writes the result next
 * to the other benchmark JSONs.
 *
 *   pnpm benchmark:tokenizer
 *
 * `reference` is js-tiktoken's own merge (`Tiktoken.encode`), i.e. the code
 * that was quadratic; `fast` is `countTokensFast`, the heap-based replacement.
 * The reference is the slow one, so it is measured once per size by default —
 * raise PILOTDECK_TOKENIZER_REPEATS if you want medians.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { countTokensFast, getTokenizer } from "../src/context/budget/tokenizer.js";

const LENGTHS = [500, 1000, 2000, 4000, 8000];
const REPEATS = Number(process.env.PILOTDECK_TOKENIZER_REPEATS ?? 1);
const CHAR = "x";

function timeOne(fn: (text: string) => number, text: string): number {
  const started = performance.now();
  fn(text);
  return performance.now() - started;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function main(): void {
  const reference = (text: string): number => getTokenizer().encode(text).length;
  const tokenizer = getTokenizer();

  const rows = LENGTHS.map((length) => {
    const text = CHAR.repeat(length);
    const referenceMs = median(Array.from({ length: REPEATS }, () => timeOne(reference, text)));
    const fastMs = median(
      Array.from({ length: REPEATS }, () => timeOne((t) => countTokensFast(t, tokenizer), text)),
    );
    return {
      length,
      referenceMs: Math.round(referenceMs * 100) / 100,
      fastMs: Math.round(Math.max(fastMs, 0.01) * 100) / 100,
      speedup: Math.round((referenceMs / Math.max(fastMs, 0.01)) * 10) / 10,
    };
  });

  // Both counters must agree on every measured input, otherwise the timings
  // are comparing two different functions.
  for (const row of rows) {
    const text = CHAR.repeat(row.length);
    if (countTokensFast(text, tokenizer) !== reference(text)) {
      throw new Error(`counters disagree at length ${row.length}; timings are not comparable`);
    }
  }

  const growth = rows.slice(1).map((row, index) => {
    const previous = rows[index]!;
    return Math.round((row.referenceMs / previous.referenceMs) * 100) / 100;
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    protocol: "benchmarks/tokenizerScaling.ts",
    input: `"${CHAR}" repeated N times (a single pre-token — the worst case for the merge)`,
    repeats: REPEATS,
    rows,
    referenceGrowthPerDoubling: growth,
  };
  const resultsDir = resolve(join(process.cwd(), "benchmarks", "results"));
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = resolve(resultsDir, `tokenizer-scaling-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log("| input | reference (js-tiktoken) ms | countTokensFast ms | speedup |");
  console.log("|---:|---:|---:|---:|");
  for (const row of rows) {
    console.log(`| ${row.length} | ${row.referenceMs} | ${row.fastMs} | ${row.speedup}x |`);
  }
  console.log(`\nreference growth per doubling: ${growth.join(", ")}x (quadratic ≈ 4x)`);
  console.log("results written:", outputPath);
}

main();
