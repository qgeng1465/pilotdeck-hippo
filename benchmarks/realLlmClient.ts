import { performance } from "node:perf_hooks";
import { messageVisibleText } from "hippo-retention";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../src/model/index.js";

// Shared plumbing for the real-LLM benchmarks (`realLlmEval.ts` and
// `realLlmTopicSwitch.ts`): endpoint resolution, the chat call with retries,
// a CanonicalModel adapter, and answer grading.
//
// Kept in its own module so both benchmarks spend the same quota the same way
// and neither can drift into a slightly different retry/timeout/parsing
// policy — a difference that would show up as a difference between their
// results.

const DEFAULT_API_URL = "https://api.deepseek.com/v1/chat/completions";
export const MODEL = process.env.PILOTDECK_EVAL_MODEL ?? "deepseek-v4-flash";

let API_URL = DEFAULT_API_URL;

export function configureEndpoint(url: string): void {
  API_URL = url;
}

export type ChatUsage = { promptTokens: number; completionTokens: number };

/**
 * Endpoint resolution: `PILOTDECK_EVAL_URL` + `PILOTDECK_EVAL_KEY`
 * (or `DEEPSEEK_API_KEY`) from the environment, falling back to the public
 * DeepSeek endpoint — which needs `DEEPSEEK_API_KEY` too, so either way the
 * key is supplied by the caller's environment and never read off disk.
 */
export function loadEndpoint(): { url: string; apiKey: string; source: string } {
  const envUrl = process.env.PILOTDECK_EVAL_URL;
  const envKey = process.env.PILOTDECK_EVAL_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (!envKey) {
    throw new Error(
      "No API key for the real-LLM benchmarks. Set PILOTDECK_EVAL_KEY (with "
      + "PILOTDECK_EVAL_URL for a custom OpenAI-compatible endpoint) or "
      + "DEEPSEEK_API_KEY. See .env.example.",
    );
  }
  if (envUrl) {
    return {
      url: `${envUrl.replace(/\/+$/, "")}/chat/completions`,
      apiKey: envKey,
      source: "PILOTDECK_EVAL_URL",
    };
  }
  return { url: DEFAULT_API_URL, apiKey: envKey, source: DEFAULT_API_URL };
}

export async function chat(
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

export function canonicalToOpenaiMessages(request: CanonicalModelRequest) {
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

export function createRealModel(apiKey: string) {
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

/**
 * The model under test is asked for exactly `gene=… freq=… stat=…`, so grading
 * is a format match plus numeric equality — no second model in the loop, and
 * no room for a grader to be generous. Anything that does not match the format
 * (including the instructed `NOT_IN_CONTEXT` answer) counts as wrong.
 */
export function gradeAnswer(answer: string, parsed: { gene: string; freq: string; stat: string }): boolean {
  const match = answer.match(/gene=([A-Za-z0-9._-]+)\s+freq=([\d.]+)\s+stat=([\d.]+)/);
  if (!match) return false;
  return match[1]!.toUpperCase() === parsed.gene.toUpperCase()
    && Math.abs(Number.parseFloat(match[2]!) - Number.parseFloat(parsed.freq)) < 1e-6
    && Math.abs(Number.parseFloat(match[3]!) - Number.parseFloat(parsed.stat)) < 1e-6;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
