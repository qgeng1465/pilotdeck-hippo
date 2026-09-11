import { createHash } from "node:crypto";
import { runEngine } from "./engineRunner.js";
import { generateTranscript, type SyntheticTranscript } from "./syntheticTranscript.js";

export type CaseMetrics = {
  numPairs: number;
  seed: number;
  preTokens: number;
  upstream: {
    postTokens: number;
    messagesSummarized: number;
    messagesToKeep: number;
    factsRetained: number;
    fingerprint: string;
  };
  hippo: {
    postTokens: number;
    messagesSummarized: number;
    messagesToKeep: number;
    factsRetained: number;
    fingerprint: string;
    deterministic: boolean;
  };
  ratioPost: number;
  factsRatio: number;
};

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function countFacts(transcript: SyntheticTranscript, text: string): number {
  return transcript.facts.filter((fact) => text.includes(fact.marker)).length;
}

export async function runCase(numPairs: number, seed: number): Promise<CaseMetrics> {
  const transcript = generateTranscript({ numPairs, seed });
  const upstream = await runEngine(transcript.messages, "upstream");
  const hippo = await runEngine(transcript.messages, "hippo");
  const hippoAgain = await runEngine(transcript.messages, "hippo");
  const upstreamText = upstream.fingerprint;
  const hippoText = hippo.fingerprint;

  return {
    numPairs,
    seed,
    preTokens: upstream.result.preTokens,
    upstream: {
      postTokens: upstream.postTokens,
      messagesSummarized: upstream.result.messagesSummarized,
      messagesToKeep: upstream.result.messagesToKeep.length,
      factsRetained: countFacts(transcript, upstreamText),
      fingerprint: hashText(upstreamText),
    },
    hippo: {
      postTokens: hippo.postTokens,
      messagesSummarized: hippo.result.messagesSummarized,
      messagesToKeep: hippo.result.messagesToKeep.length,
      factsRetained: countFacts(transcript, hippoText),
      fingerprint: hashText(hippoText),
      deterministic: hashText(hippoText) === hashText(hippoAgain.fingerprint),
    },
    ratioPost: upstream.postTokens > 0 ? hippo.postTokens / upstream.postTokens : 0,
    factsRatio: transcript.facts.length > 0
      ? (countFacts(transcript, hippoText) - countFacts(transcript, upstreamText)) / transcript.facts.length
      : 0,
  };
}
