import type { BrowserSession } from "../computer/browser";
import type { Shell } from "../computer/shell";
import type { WorkspaceFS } from "../computer/files";
import type { ToolSpec } from "./types";

export interface ToolContext {
  fs: WorkspaceFS;
  shell: Shell;
  browser: BrowserSession;
  /** Present only for top-level agents; enables the spawn_subagent tool. */
  spawnSubagent?: (goal: string, maxSteps?: number, parentId?: string) => Promise<string>;
}

export interface ToolMeta {
  /** The id of the task whose loop is invoking the tool. */
  taskId?: string;
}

export type ToolControl =
  | { type: "complete"; summary: string }
  | { type: "takeover"; reason: string };

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  control?: ToolControl;
}

type Handler = (
  input: Record<string, unknown>,
  ctx: ToolContext,
  meta: ToolMeta,
) => Promise<ToolOutcome>;

interface ToolDef {
  spec: ToolSpec;
  handler: Handler;
}

// --- tiny input validators (schema is advisory; never trust model output) ---

function reqStr(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

function optStr(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

function optStrArray(input: Record<string, unknown>, key: string): string[] {
  const v = input[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`"${key}" must be an array of strings`);
  }
  return v as string[];
}

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const READ_CAP = 16_000;

function buildTools(): ToolDef[] {
  return [
    {
      spec: {
        name: "fs_write",
        description:
          "Write a UTF-8 text file in the workspace, creating parent folders as needed. Paths are relative to the workspace root.",
        inputSchema: obj(
          { path: { type: "string" }, content: { type: "string" } },
          ["path", "content"],
        ),
      },
      handler: async (input, ctx) => {
        const p = reqStr(input, "path");
        const content = reqStr(input, "content");
        await ctx.fs.write(p, content);
        return { content: `wrote ${p} (${Buffer.byteLength(content)} bytes)` };
      },
    },
    {
      spec: {
        name: "fs_read",
        description: "Read a UTF-8 text file from the workspace.",
        inputSchema: obj({ path: { type: "string" } }, ["path"]),
      },
      handler: async (input, ctx) => {
        const p = reqStr(input, "path");
        const data = await ctx.fs.read(p);
        return {
          content: data.length > READ_CAP ? `${data.slice(0, READ_CAP)}\n…[truncated]` : data,
        };
      },
    },
    {
      spec: {
        name: "fs_list",
        description: "List the entries of a directory in the workspace (defaults to the root).",
        inputSchema: obj({ path: { type: "string" } }, []),
      },
      handler: async (input, ctx) => {
        const p = optStr(input, "path") ?? ".";
        const entries = await ctx.fs.list(p);
        const body = entries.map((e) => `${e.type === "dir" ? "d" : "-"} ${e.name}`).join("\n");
        return { content: body || "(empty)" };
      },
    },
    {
      spec: {
        name: "shell_run",
        description:
          "Run an allowlisted command in the workspace. `command` is a bare executable name; `args` is an array of arguments (no shell interpretation).",
        inputSchema: obj(
          {
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
          },
          ["command"],
        ),
      },
      handler: async (input, ctx) => {
        const command = reqStr(input, "command");
        const args = optStrArray(input, "args");
        const r = await ctx.shell.run(command, args);
        const parts = [
          `exit=${r.code ?? "null"}${r.timedOut ? " (timed out)" : ""}${r.truncated ? " (output truncated)" : ""}`,
        ];
        if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
        if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
        return { content: parts.join("\n"), isError: r.timedOut };
      },
    },
    {
      spec: {
        name: "browser_navigate",
        description: "Open a public http(s) URL in the persistent browser and report status + title.",
        inputSchema: obj({ url: { type: "string" } }, ["url"]),
      },
      handler: async (input, ctx) => {
        const url = reqStr(input, "url");
        const r = await ctx.browser.goto(url);
        return { content: JSON.stringify(r) };
      },
    },
    {
      spec: {
        name: "browser_read",
        description: "Read the visible text of the current browser page.",
        inputSchema: obj({}, []),
      },
      handler: async (_input, ctx) => ({ content: await ctx.browser.readText() }),
    },
    {
      spec: {
        name: "browser_screenshot",
        description: "Capture a full-page screenshot of the current page; returns the saved file path.",
        inputSchema: obj({ name: { type: "string" } }, []),
      },
      handler: async (input, ctx) => {
        const file = await ctx.browser.screenshot(optStr(input, "name"));
        return { content: `screenshot saved: ${file}` };
      },
    },
    {
      spec: {
        name: "browser_click",
        description: "Click the first element matching a CSS selector on the current page.",
        inputSchema: obj({ selector: { type: "string" } }, ["selector"]),
      },
      handler: async (input, ctx) => ({ content: await ctx.browser.click(reqStr(input, "selector")) }),
    },
    {
      spec: {
        name: "browser_type",
        description: "Fill a form field matching a CSS selector with the given text.",
        inputSchema: obj(
          { selector: { type: "string" }, text: { type: "string" } },
          ["selector", "text"],
        ),
      },
      handler: async (input, ctx) => ({
        content: await ctx.browser.type(reqStr(input, "selector"), reqStr(input, "text")),
      }),
    },
    {
      spec: {
        name: "request_human_takeover",
        description:
          "Pause the task and hand the browser to the human — use for logins, CAPTCHAs, payments, or any decision you should not make autonomously. The task resumes after the human is done.",
        inputSchema: obj({ reason: { type: "string" } }, ["reason"]),
      },
      handler: async (input) => {
        const reason = reqStr(input, "reason");
        return {
          content: `Paused for human takeover: ${reason}. When the task resumes, assume the human has completed the manual step and continue.`,
          control: { type: "takeover", reason },
        };
      },
    },
    {
      spec: {
        name: "spawn_subagent",
        description:
          "Delegate a focused, self-contained sub-goal to a short-lived subagent that shares the same computer. Returns the subagent's result summary. Subagents cannot spawn further subagents.",
        inputSchema: obj({ goal: { type: "string" }, maxSteps: { type: "number" } }, ["goal"]),
      },
      handler: async (input, ctx, meta) => {
        if (!ctx.spawnSubagent) {
          return { content: "subagents are not enabled for this agent", isError: true };
        }
        const goal = reqStr(input, "goal");
        const maxSteps = typeof input.maxSteps === "number" ? input.maxSteps : undefined;
        const result = await ctx.spawnSubagent(goal, maxSteps, meta.taskId);
        return { content: result };
      },
    },
    {
      spec: {
        name: "task_complete",
        description: "Signal that the goal is achieved. Provide a concise summary of what was done.",
        inputSchema: obj({ summary: { type: "string" } }, ["summary"]),
      },
      handler: async (input) => {
        const summary = reqStr(input, "summary");
        return { content: `completed: ${summary}`, control: { type: "complete", summary } };
      },
    },
  ];
}

export class ToolRegistry {
  private readonly defs = new Map<string, ToolDef>();

  constructor(private readonly ctx: ToolContext) {
    for (const d of buildTools()) this.defs.set(d.spec.name, d);
  }

  specs(): ToolSpec[] {
    return [...this.defs.values()].map((d) => d.spec);
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    meta: ToolMeta = {},
  ): Promise<ToolOutcome> {
    const def = this.defs.get(name);
    if (!def) return { content: `unknown tool: ${name}`, isError: true };
    try {
      return await def.handler(input, this.ctx, meta);
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
  }
}
