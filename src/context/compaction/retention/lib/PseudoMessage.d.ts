import type { HippoMessage } from "./HippoMessage.js";
/**
 * Runtime bookkeeping that looks like conversation but is not.
 *
 * These constants and {@link isSyntheticPseudoMessage} live in this package
 * (rather than in the host's tool-pair-integrity module, where they started)
 * because the retention policy is their only *consumer*: they exist to stop a
 * marker from being retained verbatim. The host keeps
 * `isRealUserRequestMessage`, which reads the same constants to decide whether
 * a message can anchor a live tail — it imports them from here.
 */
export declare const COMPACTION_CONTINUATION_TEXT = "[system: the conversation above has been compacted. please continue with the current task.]";
export declare const INTERNAL_USER_TEXT_PREFIXES: string[];
/**
 * True only for a message the runtime injected as bookkeeping rather than text
 * a participant produced: compact/snip boundary markers, the compaction
 * continuation sentinel, hook and memory context, and anything stamped
 * `metadata.synthetic`.
 *
 * Retaining one replays a marker *in place of* a turn the budget was meant to
 * preserve — observed in a live session where a 26-token `<snip-boundary>`
 * absorbed a 1612-token retention budget.
 *
 * Deliberately narrower than "not a real user request": tool results also fail
 * that test but do carry content, so they stay eligible.
 */
export declare function isSyntheticPseudoMessage(message: HippoMessage): boolean;
