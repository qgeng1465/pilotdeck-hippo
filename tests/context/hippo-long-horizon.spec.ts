import assert from "node:assert/strict";
import test from "node:test";

import { buildEbbinghausPageRankPolicy, type EbbinghausPageRankPolicy } from "hippo-retention";
import { createSnipBoundary } from "../../src/context/compaction/SnipEngine.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import { generateTranscript } from "../../benchmarks/syntheticTranscript.js";
import { runEngine } from "../../benchmarks/engineRunner.js";

/**
 * Long-horizon carry-over: a fact one compaction kept verbatim should not be
 * re-scored from zero by the next one and silently dropped.
 *
 * The mechanism is a bounded allowance (`CARRYOVER_BUDGET_SHARE` of the
 * retention budget) offered to messages a previous compaction marked
 * `metadata.hippoRetained`, filled best-current-score first. It is a cap on
 * spend rather than a score bonus, so current-query relevance is never
 * out-ranked and the hard retention budget still bounds the block.
 */

const QUERY = "retention budget ratio";

function textMessage(text: string, metadata?: CanonicalMessage["metadata"]): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }], ...(metadata ? { metadata } : {}) };
}

/**
 * Five candidates, four fit. Similarity alone decides (weights pinned to the
 * similarity term) so the ordering is exactly "how much of the query does this
 * message mention"; the carried message mentions none of it.
 *
 *   carried  0.0000   <- the only one a previous compaction kept verbatim
 *   fresh A  0.7045   "retention budget ratio"
 *   fresh B  0.5420   "retention budget"
 *   fresh C  0.2430   "retention"
 *   fresh D  0.2265   "retention settings"
 */
function carryOverFixture(): { carried: CanonicalMessage; fresh: CanonicalMessage[] } {
  const carried = textMessage("The migration window closed in March.", { hippoRetained: true });
  const fresh = [
    textMessage("retention budget ratio for the tail"),
    textMessage("retention budget for the tail"),
    textMessage("retention for the tail"),
    textMessage("retention settings for the tail"),
  ];
  return { carried, fresh };
}

const TEN_TOKENS_PER_MESSAGE = (messages: CanonicalMessage[]): number => messages.length * 10;

async function pick(
  policy: EbbinghausPageRankPolicy<CanonicalMessage>,
  candidates: CanonicalMessage[],
): Promise<CanonicalMessage[]> {
  return policy.pickRetained({
    candidates,
    retentionBudgetTokens: 40,
    estimateTokens: TEN_TOKENS_PER_MESSAGE,
    queryHint: QUERY,
  });
}

test("a message kept verbatim by a previous compaction keeps a slot on the next one", async () => {
  const { carried, fresh } = carryOverFixture();
  const retained = await pick(
    buildEbbinghausPageRankPolicy<CanonicalMessage>({ wSim: 1, wTime: 0, wRank: 0 }),
    [carried, ...fresh],
  );

  assert.ok(retained.includes(carried), "the carried message must survive the second pass");
  // The point of a *bounded* allowance: the two most relevant fresh messages
  // keep their slots. Carry-over may only displace the tail of the block.
  assert.ok(retained.includes(fresh[0]!), "the best-matching message must not be out-ranked");
  assert.ok(retained.includes(fresh[1]!), "the second-best message must not be out-ranked");
  assert.equal(retained.length, 4, "the block must not grow to make room for carry-over");
  assert.equal(
    retained.reduce((total, message) => total + TEN_TOKENS_PER_MESSAGE([message]), 0),
    40,
    "the retention token budget stays hard",
  );
});

test("without the retained marker the same message is dropped: a plain score fill has no memory", async () => {
  const { fresh } = carryOverFixture();
  const unmarked = textMessage("The migration window closed in March.");
  const retained = await pick(
    buildEbbinghausPageRankPolicy<CanonicalMessage>({ wSim: 1, wTime: 0, wRank: 0 }),
    [unmarked, ...fresh],
  );

  assert.ok(!retained.includes(unmarked), "an unmarked message must not be given a slot it cannot win");
  assert.deepEqual(retained, fresh, "the four highest-scoring messages are what the fill keeps");
});

test("PILOTDECK_CARRYOVER=off disables the allowance while retention keeps running", async () => {
  const { carried, fresh } = carryOverFixture();
  const previous = process.env.PILOTDECK_CARRYOVER;
  process.env.PILOTDECK_CARRYOVER = "off";
  try {
    const retained = await pick(
      buildEbbinghausPageRankPolicy<CanonicalMessage>({ wSim: 1, wTime: 0, wRank: 0 }),
      [carried, ...fresh],
    );
    assert.ok(!retained.includes(carried), "the kill switch must restore the plain score fill");
    assert.equal(retained.length, 4);
  } finally {
    if (previous === undefined) delete process.env.PILOTDECK_CARRYOVER;
    else process.env.PILOTDECK_CARRYOVER = previous;
  }
});

test("a zero carry-over share disables the allowance without the global switch", async () => {
  const { carried, fresh } = carryOverFixture();
  const retained = await pick(
    buildEbbinghausPageRankPolicy<CanonicalMessage>({ wSim: 1, wTime: 0, wRank: 0, carryOverBudgetShare: 0 }),
    [carried, ...fresh],
  );

  assert.ok(!retained.includes(carried));
  assert.equal(retained.length, 4);
});

// --- engine wiring ---

test("the engine marks what the policy kept so the next compaction can carry it", async () => {
  const transcript = generateTranscript({ numPairs: 80, seed: 20260911 });
  const first = await runEngine(transcript.messages, "hippo");
  const marked = first.result.messagesToKeep.filter((message) => message.metadata?.hippoRetained === true);
  assert.ok(marked.length > 0, "the kept-verbatim messages must be marked in the transcript");
  assert.ok(
    marked.length <= (first.result.retention?.retainedMessages ?? 0),
    "only messages the policy actually contributed may be marked",
  );

  // The kept tail is what the next compaction re-plans over, so the marker has
  // to survive round-tripping through the post-compaction message list.
  const second = await runEngine(first.postMessages, "hippo");
  assert.ok(
    second.result.messagesToKeep.some((message) => message.metadata?.hippoRetained === true),
    "a carried message must still be recognizable on the following pass",
  );
});

test("carry-over marking changes nothing but the marking: same summary bucket, same kept order", async () => {
  // The marked copy that lands in `messagesToKeep` is a *different object* from
  // the one the policy picked. Any lookup keyed on the copy (the Set that
  // filters the summary bucket, the Map that restores transcript order) silently
  // misses, and the failure is invisible in the token totals: the retained
  // message is then summarized *and* kept verbatim, and every copy sorts to the
  // front of the prefix because it has no transcript index. Both are visible
  // here, and only here.
  const transcript = generateTranscript({ numPairs: 80, seed: 20260911 });
  const previous = process.env.PILOTDECK_CARRYOVER;
  let on: Awaited<ReturnType<typeof runEngine>>;
  let off: Awaited<ReturnType<typeof runEngine>>;
  try {
    delete process.env.PILOTDECK_CARRYOVER;
    on = await runEngine(transcript.messages, "hippo");
    process.env.PILOTDECK_CARRYOVER = "off";
    off = await runEngine(transcript.messages, "hippo");
  } finally {
    if (previous === undefined) delete process.env.PILOTDECK_CARRYOVER;
    else process.env.PILOTDECK_CARRYOVER = previous;
  }

  assert.ok(
    (on.result.retention?.retainedMessages ?? 0) > 0,
    "the on arm must actually retain something for this to be a test",
  );
  assert.equal(
    on.result.messagesSummarized,
    off.result.messagesSummarized,
    "a message kept verbatim must be pulled out of the summary bucket, not both kept and summarized",
  );
  assert.equal(
    on.result.retention?.retainedMessages,
    off.result.retention?.retainedMessages,
  );
  assert.equal(
    on.fingerprint,
    off.fingerprint,
    "the kept block must stay in transcript order; only the retention marking may differ",
  );
});

test("PILOTDECK_CARRYOVER=off leaves no carry-over trace in the transcript", async () => {
  const transcript = generateTranscript({ numPairs: 80, seed: 20260911 });
  const previous = process.env.PILOTDECK_CARRYOVER;
  process.env.PILOTDECK_CARRYOVER = "off";
  try {
    const run = await runEngine(transcript.messages, "hippo");
    assert.ok(
      (run.result.retention?.retainedMessages ?? 0) > 0,
      "retention itself must still run; only carry-over is switched off",
    );
    assert.equal(
      run.postMessages.filter((message) => message.metadata?.hippoRetained === true).length,
      0,
      "with carry-over off nothing of the mechanism may be written into the transcript",
    );
  } finally {
    if (previous === undefined) delete process.env.PILOTDECK_CARRYOVER;
    else process.env.PILOTDECK_CARRYOVER = previous;
  }
});

// --- boundary markers are runtime bookkeeping, not conversation ---

test("boundary markers are stamped synthetic so consumers recognize them structurally", async () => {
  const snip = createSnipBoundary(2, 3, 4);
  assert.equal(snip.metadata?.synthetic, true);
  assert.equal(snip.metadata?.purpose, "snip-boundary");

  const transcript = generateTranscript({ numPairs: 80, seed: 20260911 });
  const run = await runEngine(transcript.messages, "hippo");
  assert.equal(run.result.boundaryMarker.metadata?.synthetic, true);
  assert.equal(run.result.boundaryMarker.metadata?.purpose, "compact-boundary");
});
