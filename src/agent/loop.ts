import type { TaskEngine } from "../tasks/engine";
import type { ToolRegistry } from "./tools";
import type { AssistantToolUse, Brain, ConversationEntry, ToolResult } from "./types";

export interface LoopDeps {
  brain: Brain;
  tools: ToolRegistry;
  engine: TaskEngine;
}

const SYSTEM_PROMPT = `You are 999, a capable personal agent that operates its own computer to accomplish a user's goal.

Your computer has:
- a workspace filesystem (fs_read / fs_write / fs_list) — all paths are relative to a jailed workspace root;
- a sandboxed shell (shell_run) — only an allowlist of commands is available, with no shell interpretation; pass arguments as an array;
- a persistent browser (browser_navigate / browser_read / browser_click / browser_type / browser_screenshot) — the profile persists, so a human can sign in once and you reuse the session.

How to work:
- Think about the goal, then take one concrete action at a time using the tools.
- Prefer reading/observing (browser_read, fs_read, fs_list) before acting.
- Keep any text you write short — it is logged as your reasoning for the operator.
- When you need a human to do something you should not do yourself (log in, solve a CAPTCHA, enter payment details, approve an irreversible or sensitive action), call request_human_takeover with a clear reason instead of attempting it.
- When the goal is achieved, call task_complete with a concise summary. Do not keep going after that.
- If a tool returns an error, read it and adapt; don't repeat the same failing call.

Safety: you only have the tools above. Do not attempt to bypass the sandbox, exfiltrate secrets, or act against the user's interest.`;

/**
 * The agentic loop for one task. Holds the conversation so a paused task can be
 * resumed in-process with its context intact. Cooperative control (pause/cancel)
 * is checked once per iteration; every model turn and tool call is written to
 * the task's operation log.
 */
export class AgentLoop {
  private history: ConversationEntry[] = [];
  private started = false;

  constructor(
    private readonly taskId: string,
    private readonly deps: LoopDeps,
  ) {}

  async run(): Promise<void> {
    const { engine, brain, tools } = this.deps;
    const task = engine.get(this.taskId);
    if (!task) return;

    if (!this.started) {
      this.history = [{ role: "user", text: `Goal: ${task.goal}` }];
      this.started = true;
    }
    engine.setStatus(this.taskId, "running");

    try {
      for (;;) {
        const current = engine.get(this.taskId);
        if (!current) return;

        const control = engine.consumeControl(this.taskId);
        if (control === "cancel") {
          engine.setStatus(this.taskId, "cancelled");
          return;
        }
        if (control === "pause") {
          engine.setStatus(this.taskId, "paused");
          return;
        }
        if (current.steps >= current.maxSteps) {
          engine.fail(this.taskId, `reached max steps (${current.maxSteps})`);
          return;
        }

        const turn = await brain.respond({
          system: SYSTEM_PROMPT,
          history: this.history,
          tools: tools.specs(),
        });
        this.history.push({ role: "assistant", raw: turn.rawAssistantContent });

        const say = turn.blocks
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (say) engine.appendLog(this.taskId, "model", say);

        if (turn.stopReason === "refusal") {
          engine.fail(this.taskId, `model refused: ${turn.refusal ?? "unspecified"}`);
          return;
        }

        const toolUses = turn.blocks.filter(
          (b): b is AssistantToolUse => b.type === "tool_use",
        );

        if (toolUses.length === 0) {
          engine.complete(this.taskId, say || "(agent produced no further actions)");
          return;
        }
        if (turn.stopReason === "max_tokens") {
          engine.fail(this.taskId, "model hit max_tokens mid tool-call");
          return;
        }

        const results: ToolResult[] = [];
        let terminal: { kind: "complete" | "takeover"; text: string } | null = null;

        for (const tu of toolUses) {
          engine.appendLog(this.taskId, "tool_call", tu.name, tu.input);
          const outcome = await tools.execute(tu.name, tu.input, { taskId: this.taskId });
          engine.appendLog(
            this.taskId,
            outcome.isError ? "error" : "tool_result",
            `${tu.name} → ${outcome.isError ? "error" : "ok"}`,
            outcome.content.slice(0, 2000),
          );
          results.push({ toolUseId: tu.id, content: outcome.content, isError: outcome.isError });
          if (outcome.control?.type === "complete") {
            terminal = { kind: "complete", text: outcome.control.summary };
          } else if (outcome.control?.type === "takeover") {
            terminal = { kind: "takeover", text: outcome.control.reason };
          }
        }

        this.history.push({ role: "user", toolResults: results });
        engine.incrementSteps(this.taskId);

        if (terminal?.kind === "complete") {
          engine.complete(this.taskId, terminal.text);
          return;
        }
        if (terminal?.kind === "takeover") {
          engine.appendLog(this.taskId, "human", `takeover requested: ${terminal.text}`);
          engine.setStatus(this.taskId, "paused");
          return;
        }
      }
    } catch (err) {
      engine.fail(this.taskId, (err as Error).message);
    }
  }
}
