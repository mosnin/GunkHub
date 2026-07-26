/**
 * Shared helpers for the tool modules.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Wrap a projection as a tool result.
 *
 * COMPACT JSON, no indentation, deliberately. Pretty-printing a tier-1 list of
 * 40 patterns costs hundreds of tokens in whitespace alone, and nothing
 * downstream reads it with human eyes.
 *
 * No `structuredContent` / `outputSchema` either: the MCP SDK sends the
 * structured copy IN ADDITION to the text one, so declaring an output schema
 * would roughly double every response for a caller that only reads the text.
 * On a surface whose entire purpose is token economy, that trade is backwards.
 */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}
