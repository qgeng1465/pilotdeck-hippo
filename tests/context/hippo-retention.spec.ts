import assert from "node:assert/strict";
import test from "node:test";

import { buildEbbinghausPageRankPolicy } from "../../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import { EntityGraph } from "../../src/context/compaction/retention/EntityGraph.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import { generateTranscript, generateZhTranscript } from "../../benchmarks/syntheticTranscript.js";
import { runEngine } from "../../benchmarks/engineRunner.js";

test("hippo score policy is deterministic and keeps key messages within the retention budget", async () => {
  const transcript = generateTranscript({ numPairs: 40, seed: 20260911 });
  const candidates = transcript.messages.slice(0, 60);
  const lastMessage = transcript.messages.at(-1)!;
  const lastTextBlock = lastMessage.content.find((block) => block.type === "text");
  const queryHint = lastTextBlock?.text ?? "";
  const policy = buildEbbinghausPageRankPolicy();
  const first = await policy.scoreMessages({ candidates, queryHint });
  const second = await policy.scoreMessages({ candidates, queryHint });
  assert.equal([...first.entries()].sort((a, b) => a[1] - b[1]).map(([message, score]) => `${message.role}:${score}`).join("\n"),
    [...second.entries()].sort((a, b) => a[1] - b[1]).map(([message, score]) => `${message.role}:${score}`).join("\n"));

  const budget = 300;
  const retained = await policy.pickRetained({
    candidates,
    retentionBudgetTokens: budget,
    estimateTokens: (messages) => new TokenBudgetManager().estimateMessagesTokens(messages),
    queryHint,
  });
  assert.ok(retained.length > 0);
  assert.ok(new TokenBudgetManager().estimateMessagesTokens(retained) <= budget);
});

test("scorePolicy=undefined output matches the upstream baseline byte-for-byte", async () => {
  const transcript = generateTranscript({ numPairs: 48, seed: 20260911 });
  const upstream = await runEngine(transcript.messages, "upstream");
  const unchanged = await runEngine(transcript.messages, "upstream");
  assert.equal(upstream.fingerprint, unchanged.fingerprint);
  assert.equal(upstream.postTokens, unchanged.postTokens);
  assert.equal(upstream.result.messagesSummarized, unchanged.result.messagesSummarized);
});

test("hippo verbatim retention improves exact-fact recovery over the deterministic baseline", async () => {
  const transcript = generateTranscript({ numPairs: 80, seed: 20260911 });
  const upstream = await runEngine(transcript.messages, "upstream");
  const hippo = await runEngine(transcript.messages, "hippo");
  const countFacts = (text: string) => transcript.facts.filter((fact) => text.includes(fact.marker)).length;
  assert.ok(countFacts(hippo.fingerprint) > countFacts(upstream.fingerprint));
});

test("pure-Chinese messages yield CJK bigram entities with non-zero PageRank", () => {
  const messages = [
    { text: "先完成数据质控和表达归一化，然后进入生存分析建模阶段。" },
    { text: "质控表已经读取，归一化完成，下一步准备生存分析的折拆分。" },
    { text: "TP53 突变频率 0.312 是关键检查点，后续生存模型会引用。" },
    { text: "临床协变量与突变矩阵的行顺序已确认对齐，无需重映射。" },
    { text: "低置信度记录已剔除，表型汇总重新生成，计数保持稳定。" },
    { text: "聚类漂移检测完成，源队列和目标队列的距离已记录待复核。" },
    { text: "把折文件写入暂存目录前，先核对清单校验和是否一致。" },
    { text: "生存分析建模完成，Cox 模型的协变量系数已写入报告。" },
  ];
  const graph = new EntityGraph().build(messages, { windowSize: 3 });
  graph.pageRank();
  assert.ok(
    graph.entitiesForMessage(0).length > 0,
    "pure-Chinese message must produce entities",
  );
  assert.ok(graph.rankForMessage(0) > 0, "pure-Chinese message must get non-zero rank");
  // Mixed script keeps the ASCII path intact.
  assert.ok(
    graph.entitiesForMessage(2).includes("TP53"),
    "ASCII Pascal entities must survive alongside CJK bigrams",
  );
});

test("ubiquitous CJK bigrams are pruned as stop-words; rare content bigrams survive", () => {
  const common = "把结果写入待处理队列并通知下游。";
  const messages = Array.from({ length: 10 }, (_, index) =>
    index % 2 === 0
      ? { text: `${common} 本轮关注转录组差异表达分析。` }
      : { text: `${common} 批次编号 batch=${index}，随机种子 seed=${index * 7}。` },
  );
  const graph = new EntityGraph().build(messages, { windowSize: 3 });
  const firstEntities = graph.entitiesForMessage(0);
  assert.ok(
    !firstEntities.includes("写入"),
    "bigram present in every message must be pruned as a stop-word",
  );
  assert.ok(
    firstEntities.some((entity) => entity === "差异" || entity === "转录"),
    "rare content bigrams must survive pruning",
  );
});

test("Chinese transcript: hippo verbatim retention recovers facts the upstream summary loses", async () => {
  const transcript = generateZhTranscript({ numPairs: 80, seed: 20260911 });
  const upstream = await runEngine(transcript.messages, "upstream");
  const hippo = await runEngine(transcript.messages, "hippo");
  const countFacts = (text: string) => transcript.facts.filter((fact) => text.includes(fact.marker)).length;
  assert.ok(countFacts(hippo.fingerprint) > countFacts(upstream.fingerprint));
});
