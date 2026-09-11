import type { CanonicalMessage, CanonicalToolResultContentBlock } from "../../../model/index.js";

function flattenToolResultContent(blocks: CanonicalToolResultContentBlock[]): string {
  return blocks
    .map((block) => block.type === "text" ? block.text : `[${block.type} binary payload]`)
    .join("\n");
}

/** Stable, cheap text view of a canonical message used only for scoring/demo text. */
export function messageVisibleText(message: CanonicalMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case "text":
      case "thinking":
        parts.push(block.text);
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
