import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPostCompactMessages, CompactionEngine } from "../src/context/compaction/CompactionEngine.js";
import { TokenBudgetManager } from "../src/context/budget/TokenBudgetManager.js";
import { messageVisibleText } from "../src/context/compaction/retention/MessageText.js";
import { buildEbbinghausPageRankPolicy } from "../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import type { RetentionScorePolicy } from "../src/context/compaction/retention/RetentionTypes.js";
import {
  generateTranscript,
  generateZhTranscript,
  type SyntheticFact,
  type SyntheticTranscript,
} from "./syntheticTranscript.js";
import {
  chat,
  configureEndpoint,
  createRealModel,
  gradeAnswer,
  loadEndpoint,
  median,
  MODEL,
  type ChatUsage,
} from "./realLlmClient.js";

// Real-LLM closed loop: run upstream and hippo compaction with a REAL
// summarizer model (DeepSeek V4 Flash via the OpenAI-compatible endpoint),
// then measure how well an LLM judge can answer fact questions from the
// post-compaction context alone. Reports exact-fact survival, QA accuracy,
// context tokens (what the next turn costs) and summarizer latency.
//
// Cost guard: 2 langs x 2 seeds x 2 sizes x 2 variants x (1 summary call)
// plus 8 judge calls per variant-case, all on the flash tier.
//
// This covers a transcript that stays on one topic; `realLlmTopicSwitch.ts`
// covers the mid-conversation topic switch, which this one does not.

const SEED_BASE = 20260911;
const SEEDS = 2;
const NUM_PAIRS = [80, 160] as const;
const QUESTIONS_PER_CASE = 8;

// Summary-output cap handed to the CompactionEngine per call, in completion
// tokens. This is recorded into every result JSON so a later reader can tell
// whether a "short summary" was the model's choice or the cap biting — the
// first two rounds are unreadable on exactly that point.
const MAX_SUMMARY_TOKENS = 4000;

type Variant = "upstream" | "hippo";

async function runVariant(
  transcript: SyntheticTranscript,
  variant: Variant,
  apiKey: string,
): Promise<{
  postText: string;
  postTokens: number;
  summaryMs: number;
  usage: ChatUsage;
  summaryTruncated: number;
  finishReasons: string[];
}> {
  const real = createRealModel(apiKey);
  const policy: RetentionScorePolicy | undefined = variant === "hippo"
    ? buildEbbinghausPageRankPolicy()
    : undefined;
  const engine = new CompactionEngine({
    model: real.model,
    provider: "benchmark",
    model_: MODEL,
    // Reasoning-tier models spend completion tokens on hidden reasoning
    // before writing the summary; a small budget truncates the summary
    // itself and would fake a "lossy summarizer" result. Give it headroom.
    maxOutputTokens: MAX_SUMMARY_TOKENS,
    scorePolicy: policy,
  });
  const result = await engine.run({
    trigger: "auto",
    messages: transcript.messages,
    keepTailRatio: 0.18,
    protectedToolNames: null,
  });
  const postMessages = buildPostCompactMessages(result);
  return {
    postText: postMessages.map(messageVisibleText).join("\n"),
    postTokens: result.postTokens
      ?? new TokenBudgetManager().estimateMessagesTokens(postMessages),
    summaryMs: real.wallMs.length > 0 ? real.wallMs.reduce((a, b) => a + b, 0) / real.wallMs.length : 0,
    usage: real.usage,
    summaryTruncated: real.finishReasons.filter((reason) => reason !== "stop").length,
    finishReasons: [...real.finishReasons],
  };
}

function parseFact(fact: SyntheticFact, lang: "en" | "zh") {
  const freqMatch = lang === "en"
    ? fact.text.match(/freq=([\d.]+)/)
    : fact.text.match(/突变频率为 ([\d.]+)/);
  const statMatch = lang === "en"
    ? fact.text.match(/stat=([\d.]+)/)
    : fact.text.match(/统计量为 ([\d.]+)/);
  const geneMatch = lang === "en"
    ? fact.text.match(/^FACT\d+: (\S+) /)
    : fact.text.match(/中，(\S+?) 的突变频率/);
  if (!freqMatch || !statMatch || !geneMatch) return null;
  return { gene: geneMatch[1]!, freq: freqMatch[1]!, stat: statMatch[1]! };
}

function questionFor(fact: SyntheticFact, lang: "en" | "zh"): string {
  return lang === "en"
    ? `From the conversation context, report checkpoint ${fact.marker}: which gene does it involve, and what are the exact freq and stat values recorded for it? Answer in exactly this format and nothing else: gene=<gene> freq=<value> stat=<value>`
    : `请仅根据对话上下文报告检查点 ${fact.marker}：它涉及哪个基因？为其记录的突变频率(freq)与统计量(stat)的精确值是多少？请严格按如下格式回答，不要输出其他内容：gene=<基因> freq=<数值> stat=<数值>`;
}

function pickQuestionFacts(transcript: SyntheticTranscript): SyntheticFact[] {
  const facts = transcript.facts;
  const count = Math.min(QUESTIONS_PER_CASE, facts.length);
  const picked: SyntheticFact[] = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(facts[Math.round((index * (facts.length - 1)) / Math.max(1, count - 1))]!);
  }
  return [...new Set(picked)];
}

async function main() {
  const endpoint = loadEndpoint();
  configureEndpoint(endpoint.url);
  const apiKey = endpoint.apiKey;
  console.log(`real-LLM eval: model=${MODEL}, endpoint=${endpoint.url} [${endpoint.source}], langs=en+zh, seeds=${SEEDS}, N=${NUM_PAIRS.join("/")}, questions/case=${QUESTIONS_PER_CASE}`);
  type Row = {
    lang: "en" | "zh";
    numPairs: number;
    variant: Variant;
    factsRetained: number[];
    qaCorrect: number;
    qaTotal: number;
    postTokens: number[];
    summaryMs: number[];
    promptTokens: number;
    completionTokens: number;
    judgePromptTokens: number;
    summaryCalls: number;
    summaryTruncated: number;
    finishReasons: string[];
    completionTokensPerCall: number[];
  };
  const rows = new Map<string, Row>();
  const rowFor = (lang: "en" | "zh", numPairs: number, variant: Variant): Row => {
    const key = `${lang}|${numPairs}|${variant}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        lang, numPairs, variant,
        factsRetained: [], qaCorrect: 0, qaTotal: 0,
        postTokens: [], summaryMs: [],
        promptTokens: 0, completionTokens: 0, judgePromptTokens: 0,
        summaryCalls: 0, summaryTruncated: 0, finishReasons: [], completionTokensPerCall: [],
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const lang of ["en", "zh"] as const) {
    for (const numPairs of NUM_PAIRS) {
      for (let seedOffset = 0; seedOffset < SEEDS; seedOffset += 1) {
        const seed = SEED_BASE + seedOffset;
        const transcript = lang === "en"
          ? generateTranscript({ numPairs, seed })
          : generateZhTranscript({ numPairs, seed });
        const facts = pickQuestionFacts(transcript)
          .map((fact) => ({ fact, parsed: parseFact(fact, lang) }))
          .filter((entry): entry is { fact: SyntheticFact; parsed: { gene: string; freq: string; stat: string } } => entry.parsed !== null);

        for (const variant of ["upstream", "hippo"] as const) {
          const row = rowFor(lang, numPairs, variant);
          const outcome = await runVariant(transcript, variant, apiKey);
          row.factsRetained.push(
            transcript.facts.filter((fact) => outcome.postText.includes(fact.marker)).length,
          );
          row.postTokens.push(outcome.postTokens);
          row.summaryMs.push(outcome.summaryMs);
          row.promptTokens += outcome.usage.promptTokens;
          row.completionTokens += outcome.usage.completionTokens;
          // One engine run == one summarizer call, so this cell's completion
          // count is that single call's, and the cap is testable per call
          // rather than only as a cell total.
          row.completionTokensPerCall.push(outcome.usage.completionTokens);
          row.summaryCalls += outcome.finishReasons.length;
          row.summaryTruncated += outcome.summaryTruncated;
          row.finishReasons.push(...outcome.finishReasons);
          for (const { fact, parsed } of facts) {
            const judge = await chat(apiKey, [
              {
                role: "system",
                content: lang === "en"
                  ? "You answer questions strictly from the provided conversation context. If the context lacks the answer, reply exactly: NOT_IN_CONTEXT"
                  : "你只能根据提供的对话上下文回答问题。如果上下文中没有答案，请原样回复：NOT_IN_CONTEXT",
              },
              {
                role: "user",
                content: `<conversation>\n${outcome.postText}\n</conversation>\n\n${questionFor(fact, lang)}`,
              },
            ], { maxTokens: 700 });
            row.judgePromptTokens += judge.usage.promptTokens;
            row.qaTotal += 1;
            if (gradeAnswer(judge.text, parsed)) row.qaCorrect += 1;
          }
          const pct = row.qaTotal > 0 ? Math.round((row.qaCorrect / row.qaTotal) * 100) : 0;
          const trunc = outcome.summaryTruncated > 0 ? ` summaryTruncated=${outcome.summaryTruncated}` : "";
          console.log(`  done ${lang} N=${numPairs} seed=${seed} ${variant}: facts=${row.factsRetained[row.factsRetained.length - 1]}/${transcript.facts.length} qa=${pct}% postTokens=${outcome.postTokens}${trunc}`);
        }
      }
    }
  }

  const summary = [...rows.values()].map((row) => ({
    lang: row.lang,
    numPairs: row.numPairs,
    variant: row.variant,
    factsRetainedMedian: median(row.factsRetained),
    qaAccuracy: row.qaTotal > 0 ? Math.round((row.qaCorrect / row.qaTotal) * 1000) / 10 : 0,
    qaCorrect: row.qaCorrect,
    qaTotal: row.qaTotal,
    postTokensMedian: Math.round(median(row.postTokens)),
    summaryWallMsMedian: Math.round(median(row.summaryMs)),
    summarizerPromptTokens: row.promptTokens,
    summarizerCompletionTokens: row.completionTokens,
    summarizerCalls: row.summaryCalls,
    // Per-call completion counts make the cap checkable: a run whose cells all
    // sit at exactly the cap is a truncated run, and now says so in the file.
    summarizerCompletionTokensPerCall: row.completionTokensPerCall,
    summarizerTruncated: row.summaryTruncated,
    summarizerFinishReasons: row.finishReasons,
    judgePromptTokens: row.judgePromptTokens,
  }));

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    protocol: "benchmarks/realLlmEval.ts",
    model: MODEL,
    endpoint: endpoint.source,
    maxSummaryTokens: MAX_SUMMARY_TOKENS,
    timestamp,
    summary,
  };
  const resultsDir = resolve(join(process.cwd(), "benchmarks", "results"));
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = resolve(resultsDir, `real-llm-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  const header = "| lang | N | variant | facts retained (median) | QA accuracy | post tokens | summary wall ms |";
  const rule = "|---|---|---|---|---|---|---|";
  console.log("\n" + [
    header,
    rule,
    ...summary.map((row) =>
      `| ${row.lang} | ${row.numPairs} | ${row.variant} | ${row.factsRetainedMedian} / 20 | ${row.qaAccuracy}% (${row.qaCorrect}/${row.qaTotal}) | ${row.postTokensMedian} | ${row.summaryWallMsMedian} |`),
  ].join("\n"));
  const capped = summary.filter((row) =>
    row.summarizerCompletionTokensPerCall.some((tokens) => tokens >= MAX_SUMMARY_TOKENS));
  console.log(
    `\nsummary cap ${MAX_SUMMARY_TOKENS} tok/call; `
    + `${capped.length}/${summary.length} cells had at least one call reach the cap`
    + (capped.length > 0
      ? ` (${capped.map((row) => `${row.lang}/N=${row.numPairs}/${row.variant}`).join(", ")})`
      : ""),
  );
  console.log("results written:", outputPath);
}

// Entry-point guard, same reason as `topicSwitch.ts`: this module exports
// helpers (via `realLlmClient.js`) that other benchmarks import, and an
// unguarded `main()` would spend real API quota on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
