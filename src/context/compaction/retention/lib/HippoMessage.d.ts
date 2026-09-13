/**
 * The message shape this package scores.
 *
 * Deliberately a *minimal structural supertype* of the host application's
 * message type rather than a copy of it: everything declared here is optional
 * or wider, so any host message that carries a role, a content-block array and
 * an optional metadata bag is accepted without an adapter — while this file
 * keeps zero imports, which is what lets the package be installed on its own.
 *
 * Only `role`, `content`, and the two metadata flags below are ever read by the
 * scoring policy. Everything the policy does not look at (provider reasoning
 * signatures, tool-call raw payloads, persisted-result paths, MIME details) is
 * intentionally absent here so the contract stays as small as the code's needs.
 */
export type HippoRole = "user" | "assistant";
export type HippoTextBlock = {
    type: "text";
    text: string;
};
export type HippoThinkingBlock = {
    type: "thinking";
    text: string;
};
export type HippoToolCallBlock = {
    type: "tool_call";
    id: string;
    name: string;
    /** Wide on purpose: host messages type this as `unknown`. */
    input?: unknown;
};
/**
 * A block nested inside a tool result. Host tool results carry text and binary
 * blocks; only the text body is scored, binary members fall through to the
 * `[<type> binary payload]` placeholder in `messageVisibleText`.
 */
export type HippoInlineBlock = {
    type: string;
    text?: string;
};
export type HippoToolResultBlock = {
    type: "tool_result";
    toolCallId: string;
    content: HippoInlineBlock[];
    isError?: boolean;
};
export type HippoToolResultReferenceBlock = {
    type: "tool_result_reference";
    toolCallId: string;
    preview: string;
};
export type HippoMediaReferenceBlock = {
    type: "media_reference";
    toolCallId?: string;
    preview: string;
};
/**
 * Binary payloads carry no scorable text. Listing the real discriminant values
 * (rather than a `{ type: string }` catch-all) keeps `switch` narrowing exact
 * in `messageVisibleText`: a catch-all would widen every `case` arm and break
 * the `block.text` accesses, and making the union exhaustive would collapse the
 * `default` arm to `never`.
 */
export type HippoBinaryBlock = {
    type: "image" | "pdf" | "audio";
};
export type HippoContentBlock = HippoTextBlock | HippoThinkingBlock | HippoToolCallBlock | HippoToolResultBlock | HippoToolResultReferenceBlock | HippoMediaReferenceBlock | HippoBinaryBlock;
export type HippoMessageMetadata = {
    /** True for messages the runtime injected as bookkeeping, not a participant. */
    synthetic?: boolean;
    /** True for a message a previous compaction kept verbatim (carry-over marker). */
    hippoRetained?: boolean;
};
export type HippoMessage = {
    role: HippoRole;
    content: HippoContentBlock[];
    metadata?: HippoMessageMetadata;
};
