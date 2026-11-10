/** Normalized view of the model's output, independent of the SDK, so the loop
 *  can be driven by either the real Anthropic brain or an offline mock. */

export interface AssistantTextBlock {
  type: "text";
  text: string;
}

export interface AssistantToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AssistantBlock = AssistantTextBlock | AssistantToolUse;

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "other";

export interface AssistantTurn {
  blocks: AssistantBlock[];
  stopReason: StopReason;
  /**
   * The exact assistant `content` to replay on the next request. Opaque to the
   * loop; for the real brain this is the SDK content array, which preserves
   * thinking blocks (required for correct multi-turn tool use).
   */
  rawAssistantContent: unknown;
  refusal?: string;
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ConversationEntry =
  | { role: "user"; text: string }
  | { role: "user"; toolResults: ToolResult[] }
  | { role: "assistant"; raw: unknown };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input (additionalProperties:false, required set). */
  inputSchema: Record<string, unknown>;
}

export interface BrainRequest {
  system: string;
  history: ConversationEntry[];
  tools: ToolSpec[];
}

export interface Brain {
  readonly model: string;
  respond(req: BrainRequest): Promise<AssistantTurn>;
}
