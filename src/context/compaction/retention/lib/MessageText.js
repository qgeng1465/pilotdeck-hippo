function flattenToolResultContent(blocks) {
    return blocks
        .map((block) => block.type === "text" && typeof block.text === "string"
        ? block.text
        : `[${block.type} binary payload]`)
        .join("\n");
}
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
export function messageVisibleText(message) {
    const parts = [];
    for (const block of message.content) {
        switch (block.type) {
            case "text":
                parts.push(block.text);
                break;
            case "thinking":
                // Not replayed as visible content -- see the doc comment above.
                break;
            case "tool_call":
                parts.push(`${block.name} ${JSON.stringify(block.input ?? {})}`);
                break;
            case "tool_result":
                parts.push(flattenToolResultContent(block.content));
                break;
            case "tool_result_reference":
                parts.push(block.preview);
                break;
            case "media_reference":
                parts.push(block.preview);
                break;
            default:
                parts.push(`[${block.type}]`);
                break;
        }
    }
    return parts.join("\n").trim();
}
