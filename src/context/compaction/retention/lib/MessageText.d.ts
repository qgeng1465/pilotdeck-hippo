import type { HippoMessage } from "./HippoMessage.js";
/**
 * Stable, cheap text view of a canonical message used only for scoring/demo text.
 *
 * `thinking` blocks are deliberately excluded. They are not conversational
 * content: for an assistant turn that carries only a thinking block, the
 * replayed message has an empty `content` and the text rides in
 * `reasoning_content` (`src/model/providers/openai/request.ts`). That field is
 * provider-optional — the request builder emits it, but an OpenAI-compatible
 * endpoint is free to ignore it on input, as the one used in this project does.
 * Scoring or retaining against thinking text therefore optimises for a channel
 * that is not guaranteed to exist: the message can be selected, charged against
 * the retention budget, and reported as kept while the model receives nothing.
 *
 * Callers deciding whether a message is retainable at all should treat an empty
 * return here as "not retainable" (see `EbbinghausPageRankPolicy.pickRetained`).
 */
export declare function messageVisibleText(message: HippoMessage): string;
