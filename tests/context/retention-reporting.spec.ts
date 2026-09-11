import assert from "node:assert/strict";
import test from "node:test";

import { CompactionEngine } from "../../src/context/compaction/CompactionEngine.js";
import {
  buildEbbinghausPageRankPolicy,
  EBBINGHAUS_DEFAULT_WEIGHTS,
} from "../../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../../src/model/index.js";
import { generateTranscript } from "../../benchmarks/syntheticTranscript.js";
import { fakeModel } from "../../benchmarks/engineRunner.js";

// These tests cover the *reporting* half of selective retention: the engine
// must be able to say what it kept, and that statement must survive the trip
// to the gateway event the UI renders. The scoring itself is covered by
// hippo-retention.spec.ts.

async function runWithEvents(
  messages: CanonicalMessage[],
  withPolicy: boolean,
  model: { stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> } = fakeModel,
) {
  const events: AgentEvent[] = [];
  const engine = new CompactionEngine({
    model,
    provider: "benchmark",
    model_: "benchmark-summarizer",
    maxOutputTokens: 1200,
    eventEmitter: (event) => {
      events.push(event);
    },
    ...(withPolicy ? { scorePolicy: buildEbbinghausPageRankPolicy() } : {}),
  });
  const result = await engine.run({
    trigger: "auto",
    messages,
    keepTailRatio: 0.18,
    protectedToolNames: null,
    sessionId: "retention-reporting",
    turnId: "turn-1",
  });
  const completed = events.find((event) => event.type === "compact_completed");
  assert.ok(completed && completed.type === "compact_completed");
  return { result, completed };
}

test("retention outcome reports what the policy kept, and only what survived", async () => {
  const transcript = generateTranscript({ numPairs: 80, seed: 20260911 });
  const { result, completed } = await runWithEvents(transcript.messages, true);

  assert.ok(result.retention, "expected a retention outcome when a score policy is active");
  const retention = result.retention!;
  assert.equal(retention.policyId, "ebbinghaus-pagerank");
  assert.ok(retention.retainedMessages > 0, "policy should keep at least one message at this size");
  assert.ok(retention.retainedTokens > 0, "retained messages must cost tokens");
  assert.ok(
    retention.retainedTokens <= retention.budgetTokens,
    `retained ${retention.retainedTokens} tokens must fit budget ${retention.budgetTokens}`,
  );
  assert.ok(retention.budgetTokens >= 256, "retention budget has a documented floor of 256 tokens");

  // Every retained message must actually be present in the kept set, i.e. the
  // number cannot overstate the policy's contribution.
  assert.ok(
    retention.retainedMessages <= result.messagesToKeep.length,
    "retained count cannot exceed the total kept messages it is drawn from",
  );

  // The same numbers ride the event the UI consumes.
  assert.ok(completed.retention, "compact_completed must carry the retention outcome");
  assert.deepEqual(completed.retention, retention);
});

test("default weights are the tune.ts argmax, with the out-of-sample-demoted term at zero", () => {
  assert.deepEqual(EBBINGHAUS_DEFAULT_WEIGHTS, { wSim: 0.85, wTime: 0.15, wRank: 0 });
  const policy = buildEbbinghausPageRankPolicy();
  assert.deepEqual(policy.weights, { wSim: 0.85, wTime: 0.15, wRank: 0 });
});

test("weights are normalized when reported, so a UI never shows a mis-scaled row", () => {
  const policy = buildEbbinghausPageRankPolicy({ wSim: 3, wTime: 1, wRank: 0 });
  const weights = policy.weights!;
  assert.ok(Math.abs(weights.wSim + weights.wTime + weights.wRank - 1) < 1e-9);
  assert.ok(Math.abs(weights.wSim - 0.75) < 1e-9);
});

test("no score policy (upstream path) reports no retention at all", async () => {
  const transcript = generateTranscript({ numPairs: 48, seed: 20260911 });
  const { result, completed } = await runWithEvents(transcript.messages, false);

  assert.equal(result.retention, undefined);
  assert.equal(completed.retention, undefined);
  // The serialized result must not carry the key either — a consumer that
  // spreads the object should not see `retention: undefined` appear.
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "retention"));
  assert.ok(!Object.prototype.hasOwnProperty.call(completed, "retention"));
});

test("gateway forwards retention on the agent_status the UI listens to", async () => {
  const transcript = generateTranscript({ numPairs: 80, seed: 20260911 });
  const { completed } = await runWithEvents(transcript.messages, true);

  const mapped = mapAgentEvent(completed, "run-1");
  const status = mapped.find((event) => event.type === "agent_status");
  assert.ok(status && status.type === "agent_status");
  assert.equal(status.event, "compact_completed");
  const detail = status.detail as Record<string, unknown> | undefined;
  assert.ok(detail, "agent_status must carry a detail object");
  assert.deepEqual(detail.retention, (completed as { retention?: unknown }).retention);
});

test("gateway omits the retention key entirely on the upstream path", () => {
  const mapped = mapAgentEvent({
    type: "compact_completed",
    sessionId: "s",
    turnId: "t",
    compactionId: "c",
    trigger: "auto",
    status: "success",
    preTokens: 100,
    postTokens: 50,
    messagesSummarized: 10,
  }, "run-1");
  const status = mapped.find((event) => event.type === "agent_status");
  assert.ok(status && status.type === "agent_status");
  const detail = status.detail as Record<string, unknown>;
  assert.ok(!Object.prototype.hasOwnProperty.call(detail, "retention"));
});

test("a policy that keeps nothing reports nothing rather than a zero row", async () => {
  const transcript = generateTranscript({ numPairs: 80, seed: 20260911 });
  const emptyEngine = new CompactionEngine({
    model: fakeModel,
    provider: "benchmark",
    model_: "benchmark-summarizer",
    maxOutputTokens: 1200,
    scorePolicy: {
      id: "empty",
      async scoreMessages() {
        return new Map();
      },
      async pickRetained() {
        return [];
      },
    },
  });
  const empty = await emptyEngine.run({
    trigger: "auto",
    messages: transcript.messages,
    keepTailRatio: 0.18,
    protectedToolNames: null,
  });
  assert.equal(empty.retention, undefined);

  // Sanity check on the same fixture: with a policy that does keep messages,
  // the outcome is reported — so the assertion above is about the policy's
  // result and not about a fixture that never retains anything.
  const { result } = await runWithEvents(transcript.messages, true);
  assert.ok(result.retention);
});
