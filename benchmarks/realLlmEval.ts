import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildPostCompactMessages, CompactionEngine } from "../src/context/compaction/CompactionEngine.js";
import { TokenBudgetManager } from "../src/context/budget/TokenBudgetManager.js";
import { messageVisibleText } from "../src/context/compaction/retention/MessageText.js";
import { buildEbbinghausPageRankPolicy } from "../src/context/compaction/retention/EbbinghausPageRankPolicy.js";
import type { RetentionScorePolicy } from "../src/context/compaction/retention/RetentionTypes.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../src/model/index.js";
import {
  generateTranscript,
  generateZhTranscript,
  type SyntheticFact,
  type SyntheticTranscript,
} from "./syntheticTranscript.js";

// Real-LLM closed loop: run upstream and hippo compaction with a REAL
// summarizer model (DeepSeek V4 Flash via the OpenAI-compatible endpoint),
// then measure how well an LLM judge can answer fact questions from the
// post-compaction context alone. Reports exact-fact survival, QA accuracy,
// context tokens (what the next turn costs) and summarizer latency.
//
// Cost guard: 2 langs x 2 seeds x 2 sizes x 2 variants x (1 summary call)
// plus 8 judge calls per variant-case, all on the flash tier.

const DEFAULT_API_URL = "https://api.deepseek.com/v1/chat/completions";
const MODEL = process.env.PILOTDECK_EVAL_MODEL ?? "deepseek-v4-flash";
let API_URL = DEFAULT_API_URL;
const SEED_BASE = 20260911;
const SEEDS = 2;
const NUM_PAIRS = [80, 160] as const;
const QUESTIONS_PER_CASE = 8;

// Endpoint resolution, in priority order:
// 1. PILOTDECK_EVAL_URL / PILOTDECK_EVAL_KEY env overrides;
// 2. the competition-issued gateway file `poliet_deck.txt` in the repo root
//    (【接口地址】+【API密钥】 lines) so evals spend the hackathon quota;
// 3. the personal DeepSeek key at ~/deepseek_key.txt on the official API.
function loadEndpoint(): { url: string; apiKey: string; source: string } {
  const envUrl = process.env.PILOTDECK_EVAL_URL;
  const envKey = process.env.PILOTDECK_EVAL_KEY ?? process.env.DEEPSEEK_API_KEY;
  const competitionFile = resolve(process.cwd(), "poliet_deck.txt");
  if (existsSync(competitionFile)) {
    const text = readFileSync(competitionFile, "utf8");
    const url = envUrl ?? text.match(/【接口地址】：\s*(\S+)/)?.[1];
    const apiKey = envKey ?? text.match(/【API密钥】：\s*(\S+)/)?.[1];
    if (url && apiKey) {
      return {
        url: `${url.replace(/\/+$/, "")}/chat/completions`,
        apiKey,
        source: "poliet_deck.txt (competition quota)",
      };
    }
  }
  if (envUrl && envKey) {
    return {
      url: `${envUrl.replace(/\/+$/, "")}/chat/completions`,
      apiKey: envKey,
      source: "env override",
    };
  }
  return {
    url: DEFAULT_API_URL,
    apiKey: readFileSync(join(homedir(), "deepseek_key.txt"), "utf8").trim(),
    source: "~/deepseek_key.txt (personal)",
  };
}

type ChatUsage = { promptTokens: number; completionTokens: number };

async function chat(
  apiKey: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { maxTokens?: number; temperature?: number } = {},
): Promise<{ text: string; usage: ChatUsage; wallMs: number; finishReason: string }> {
  const start = performance.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: options.temperature ?? 0,
          max_tokens: options.maxTokens ?? 800,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const payload = (await response.json()) as {
        choices: Array<{ message: { content: string }; finish_reason?: string }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      return {
        text: payload.choices[0]?.message?.content ?? "",
        usage: {
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
        },
        wallMs: performance.now() - start,
        finishReason: payload.choices[0]?.finish_reason ?? "unknown",
      };
    } catch (error) {
      lastError = error;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 2_000 * (attempt + 1)));
    }
  }
  throw lastError;
}

function canonicalToOpenaiMessages(request: CanonicalModelRequest) {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  if (request.systemPrompt?.trim()) {
    messages.push({ role: "system", content: request.systemPrompt });
  }
  for (const message of request.messages) {
    const text = messageVisibleText(message);
    if (!text.trim()) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n${text}`;
    } else {
      messages.push({ role, content: text });
    }
  }
  return messages;
}

function createRealModel(apiKey: string) {
  const usage: ChatUsage = { promptTokens: 0, completionTokens: 0 };
  const wallMs: number[] = [];
  const finishReasons: string[] = [];
  return {
    usage,
    wallMs,
    finishReasons,
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        const result = await chat(apiKey, canonicalToOpenaiMessages(request), {
          maxTokens: request.maxOutputTokens ?? 4000,
        });
        usage.promptTokens += result.usage.promptTokens;
        usage.completionTokens += result.usage.completionTokens;
        wallMs.push(result.wallMs);
        finishReasons.push(result.finishReason);
        yield { type: "text_delta", text: result.text };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
  };
}

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
    maxOutputTokens: 4000,
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

function gradeAnswer(answer: string, parsed: { gene: string; freq: string; stat: string }): boolean {
  const match = answer.match(/gene=([A-Za-z0-9._-]+)\s+freq=([\d.]+)\s+stat=([\d.]+)/);
  if (!match) return false;
  return match[1]!.toUpperCase() === parsed.gene.toUpperCase()
    && Math.abs(Number.parseFloat(match[2]!) - Number.parseFloat(parsed.freq)) < 1e-6
    && Math.abs(Number.parseFloat(match[3]!) - Number.parseFloat(parsed.stat)) < 1e-6;
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function main() {
  const endpoint = loadEndpoint();
  API_URL = endpoint.url;
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
    judgePromptTokens: row.judgePromptTokens,
  }));

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    protocol: "benchmarks/realLlmEval.ts",
    model: MODEL,
    endpoint: endpoint.source,
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
  console.log("\nresults written:", outputPath);
}

void main();
