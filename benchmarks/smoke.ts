import { runEngine } from "./engineRunner.js";
import { generateTranscript } from "./syntheticTranscript.js";

async function main() {
  const seed = 20260911;
  const transcript = generateTranscript({ numPairs: 80, seed });
  const upstream = await runEngine(transcript.messages, "upstream");
  const hippo = await runEngine(transcript.messages, "hippo");
  const upstreamRetained = transcript.facts.filter((fact) => upstream.fingerprint.includes(fact.marker));
  const hippoRetained = transcript.facts.filter((fact) => hippo.fingerprint.includes(fact.marker));
  console.log(JSON.stringify({
    facts: transcript.facts.length,
    preTokens: upstream.result.preTokens,
    upstream: {
      postTokens: upstream.postTokens,
      factsRetained: upstreamRetained.length,
      messagesSummarized: upstream.result.messagesSummarized,
    },
    hippo: {
      postTokens: hippo.postTokens,
      factsRetained: hippoRetained.length,
      messagesSummarized: hippo.result.messagesSummarized,
    },
    retainedFacts: hippoRetained.map((fact) => fact.text),
  }, null, 2));
}

void main();
