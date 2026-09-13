import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRetentionScorePolicy, embeddingLoadCacheForTests, tryLoadTransformersEmbedding } from "hippo-retention";

import { loadPilotConfig } from "../../src/pilot/config/loadPilotConfig.js";

test("resolveRetentionScorePolicy defaults to hippo and honors the off switch", () => {
  assert.ok(resolveRetentionScorePolicy(undefined), "unset config should enable the hippo policy");
  assert.ok(resolveRetentionScorePolicy({}), "empty compaction config should enable the hippo policy");
  assert.ok(resolveRetentionScorePolicy({ retention: "hippo" }));
  assert.equal(
    resolveRetentionScorePolicy({ retention: "off" }),
    undefined,
    "retention: off must restore the plain upstream compaction path",
  );
});

test("tryLoadTransformersEmbedding is memoized per model path and empty when unset", async () => {
  const previous = process.env.PILOTDECK_BGE_MODEL;
  try {
    process.env.PILOTDECK_BGE_MODEL = "";
    assert.equal(await tryLoadTransformersEmbedding(), null);
    assert.equal(embeddingLoadCacheForTests.size, 0, "no path configured: nothing memoized");

    const modelPath = join(tmpdir(), "pilotdeck-bge-not-installed");
    process.env.PILOTDECK_BGE_MODEL = modelPath;
    const first = await tryLoadTransformersEmbedding();
    const second = await tryLoadTransformersEmbedding();
    assert.equal(first, second, "consecutive calls share the same load outcome");
    assert.equal(embeddingLoadCacheForTests.size, 1, "one model path yields exactly one memoized load");
    assert.ok(embeddingLoadCacheForTests.has(modelPath));
  } finally {
    if (previous === undefined) delete process.env.PILOTDECK_BGE_MODEL;
    else process.env.PILOTDECK_BGE_MODEL = previous;
    embeddingLoadCacheForTests.clear();
  }
});

const MINIMAL_YAML = (extraAgent: string) => `schemaVersion: 1
agent:
  model: _placeholder/_placeholder
${extraAgent}model:
  providers:
    _placeholder:
      protocol: openai
      url: https://placeholder.invalid
      apiKey: placeholder
      models:
        _placeholder:
          capabilities:
            maxOutputTokens: 32768
`;

function loadConfigWithAgentSection(extraAgent: string) {
  const home = mkdtempSync(join(tmpdir(), "pilotdeck-config-"));
  try {
    writeFileSync(join(home, "pilotdeck.yaml"), MINIMAL_YAML(extraAgent), "utf8");
    return loadPilotConfig({ env: { PILOT_HOME: home } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("agent.compaction.retention parses hippo and off", () => {
  const on = loadConfigWithAgentSection("  compaction:\n    retention: hippo\n");
  assert.equal(on.config.agent.compaction?.retention, "hippo");
  assert.ok(on.diagnostics.every((diagnostic) => !diagnostic.code.startsWith("CONFIG_AGENT_COMPACTION")));

  const off = loadConfigWithAgentSection("  compaction:\n    retention: off\n");
  assert.equal(off.config.agent.compaction?.retention, "off");
  assert.equal(resolveRetentionScorePolicy(off.config.agent.compaction), undefined);
});

test("unset agent.compaction parses to undefined", () => {
  const snapshot = loadConfigWithAgentSection("");
  assert.equal(snapshot.config.agent.compaction, undefined);
  assert.ok(resolveRetentionScorePolicy(snapshot.config.agent.compaction));
});

test("invalid agent.compaction.retention warns and falls back to the default policy", () => {
  const snapshot = loadConfigWithAgentSection("  compaction:\n    retention: maybe\n");
  assert.ok(
    snapshot.diagnostics.some(
      (diagnostic) => diagnostic.code === "CONFIG_AGENT_COMPACTION_RETENTION_INVALID",
    ),
    "expected a recoverable warning diagnostic",
  );
  assert.notEqual(snapshot.config.agent.compaction?.retention, "maybe");
  assert.ok(resolveRetentionScorePolicy(snapshot.config.agent.compaction));

  const malformed = loadConfigWithAgentSection("  compaction: yes\n");
  assert.ok(
    malformed.diagnostics.some((diagnostic) => diagnostic.code === "CONFIG_AGENT_COMPACTION_INVALID"),
  );
  assert.ok(resolveRetentionScorePolicy(malformed.config.agent.compaction));
});
