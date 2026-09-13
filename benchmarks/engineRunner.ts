import { buildPostCompactMessages, CompactionEngine } from "../src/context/compaction/CompactionEngine.js";
import { TokenBudgetManager } from "../src/context/budget/TokenBudgetManager.js";
import { messageVisibleText, buildEbbinghausPageRankPolicy } from "hippo-retention";
import type { RetentionScorePolicy } from "hippo-retention";


import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../src/model/index.js";

const FAKE_SUMMARY_TEXT = [
  "## Objective",
  "Complete the TCGA-LIHC cross-domain survival pipeline.",
  "## Current State",
  "Preprocessing, distribution alignment and fold files are staged.",
  "## Remaining",
  "Train the final survival model and report the exact retained values.",
  "## Files And Artifacts",
  "None",
].join("\n");

export const fakeModel = {
  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "text_delta", text: FAKE_SUMMARY_TEXT };
    yield { type: "message_end", finishReason: "stop" };
  },
};

export type EngineVariant = "upstream" | "hippo";

export async function runEngine(
  messages: CanonicalMessage[],
  variant: EngineVariant,
  scorePolicy?: RetentionScorePolicy<CanonicalMessage>,
) {
  const policy = variant === "hippo"
    ? scorePolicy ?? buildEbbinghausPageRankPolicy()
    : undefined;
  const engine = new CompactionEngine({
    model: fakeModel,
    provider: "benchmark",
    model_: "benchmark-summarizer",
    maxOutputTokens: 1200,
    scorePolicy: policy,
  });
  const result = await engine.run({
    trigger: "auto",
    messages,
    keepTailRatio: 0.18,
    protectedToolNames: null,
  });
  const postMessages = buildPostCompactMessages(result);
  const postTokens = result.postTokens ?? new TokenBudgetManager().estimateMessagesTokens(postMessages);
  return {
    result,
    postMessages,
    postTokens,
    fingerprint: postMessages.map(messageVisibleText).join("\n"),
  };
}
