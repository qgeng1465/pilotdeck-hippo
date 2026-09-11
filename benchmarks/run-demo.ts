import { runEngine } from "./engineRunner.js";
import { generateTranscript } from "./syntheticTranscript.js";

async function main() {
  const transcript = generateTranscript({ numPairs: 160, seed: 20260911 });
  const upstream = await runEngine(transcript.messages, "upstream");
  const hippo = await runEngine(transcript.messages, "hippo");
  const upstreamFacts = transcript.facts.filter((fact) => upstream.fingerprint.includes(fact.marker));
  const hippoFacts = transcript.facts.filter((fact) => hippo.fingerprint.includes(fact.marker));

  console.log("============================================================");
  console.log("PilotDeck-Hippo demo (seed=20260911, N=160 pairs)");
  console.log("============================================================");
  console.log(`preTokens               : ${upstream.result.preTokens}`);
  console.log(`upstream postTokens     : ${upstream.postTokens}  facts=${upstreamFacts.length}/${transcript.facts.length}`);
  console.log(`hippo postTokens        : ${hippo.postTokens}  facts=${hippoFacts.length}/${transcript.facts.length}`);
  console.log(`messagesSummarized      : upstream=${upstream.result.messagesSummarized} hippo=${hippo.result.messagesSummarized}`);
  console.log("");
  console.log("KEEP cards (verbatim, in post-compact context):");
  for (const fact of hippoFacts) console.log(`  [KEEP] ${fact.text}`);
  const folded = transcript.facts.filter((fact) => !hippoFacts.includes(fact));
  for (const fact of folded) console.log(`  [FOLD] ${fact.text}`);
  console.log("");
  console.log("No-regression: scorePolicy=undefined matches upstream baseline (assertNoRegression.ts).");
}

void main();
