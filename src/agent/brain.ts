import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantBlock,
  AssistantTurn,
  Brain,
  BrainRequest,
  ConversationEntry,
  StopReason,
  ToolSpec,
} from "./types";

const MAX_TOKENS = 16_000;

function toMessages(history: ConversationEntry[]): Anthropic.MessageParam[] {
  return history.map((e): Anthropic.MessageParam => {
    if (e.role === "assistant") {
      return { role: "assistant", content: e.raw as Anthropic.ContentBlockParam[] };
    }
    if ("text" in e) {
      return { role: "user", content: e.text };
    }
    return {
      role: "user",
      content: e.toolResults.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolUseId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  });
}

function toTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    strict: true,
  }));
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
    case "pause_turn":
      return reason;
    default:
      return "other";
  }
}

/** The real brain: Claude via the Anthropic SDK, with adaptive thinking. */
export class AnthropicBrain implements Brain {
  private readonly client: Anthropic;

  constructor(
    public readonly model: string,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  async respond(req: BrainRequest): Promise<AssistantTurn> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: req.system,
      tools: toTools(req.tools),
      messages: toMessages(req.history),
    });

    const blocks: AssistantBlock[] = [];
    for (const b of res.content) {
      if (b.type === "text") {
        blocks.push({ type: "text", text: b.text });
      } else if (b.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: (b.input ?? {}) as Record<string, unknown>,
        });
      }
      // thinking blocks are intentionally left only in rawAssistantContent
    }

    const stopReason = mapStop(res.stop_reason);
    const refusal =
      stopReason === "refusal"
        ? (res.stop_details as { explanation?: string } | null)?.explanation ?? "model refused"
        : undefined;

    return {
      blocks,
      stopReason,
      rawAssistantContent: res.content,
      ...(refusal ? { refusal } : {}),
    };
  }
}

/**
 * Offline stand-in for the brain. With no scripted turns it returns a harmless
 * message (so the server boots and the UI works without a credential); tests
 * supply a queue of turns to drive the loop deterministically.
 */
export class MockBrain implements Brain {
  readonly model = "mock-brain";
  private readonly queue: AssistantTurn[];

  constructor(turns: AssistantTurn[] = []) {
    this.queue = [...turns];
  }

  async respond(): Promise<AssistantTurn> {
    const next = this.queue.shift();
    if (next) return next;
    const text =
      "Mock brain active — no ANTHROPIC credential configured. Set ANTHROPIC_API_KEY to enable the real agent.";
    return {
      blocks: [{ type: "text", text }],
      stopReason: "end_turn",
      rawAssistantContent: [{ type: "text", text }],
    };
  }
}

export function textTurn(text: string): AssistantTurn {
  return {
    blocks: [{ type: "text", text }],
    stopReason: "end_turn",
    rawAssistantContent: [{ type: "text", text }],
  };
}

export function toolTurn(
  id: string,
  name: string,
  input: Record<string, unknown>,
  text?: string,
): AssistantTurn {
  const blocks: AssistantBlock[] = [];
  const raw: unknown[] = [];
  if (text) {
    blocks.push({ type: "text", text });
    raw.push({ type: "text", text });
  }
  blocks.push({ type: "tool_use", id, name, input });
  raw.push({ type: "tool_use", id, name, input });
  return { blocks, stopReason: "tool_use", rawAssistantContent: raw };
}
