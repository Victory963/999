import path from "node:path";
import { AnthropicBrain, MockBrain } from "./agent/brain";
import { AgentLoop } from "./agent/loop";
import { ToolRegistry } from "./agent/tools";
import { BrowserSession } from "./computer/browser";
import { Shell } from "./computer/shell";
import { WorkspaceFS } from "./computer/files";
import { loadConfig } from "./config";
import { GoalMonitor } from "./goals/monitor";
import { GoalStore } from "./goals/store";
import { createApp } from "./server/api";
import { Orchestrator } from "./server/orchestrator";
import { TaskEngine } from "./tasks/engine";
import { TaskStore } from "./tasks/store";

async function main(): Promise<void> {
  const config = loadConfig();

  const fs = new WorkspaceFS(config.workspaceDir, config.workspaceQuotaBytes);
  await fs.init();

  const shell = new Shell({
    cwd: config.workspaceDir,
    allow: config.shell.allow,
    timeoutMs: config.shell.timeoutMs,
    maxOutputBytes: config.shell.maxOutputBytes,
  });

  const browser = new BrowserSession(config.browser, path.join(config.workspaceDir, "screenshots"));

  const hasCreds = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const brain = hasCreds ? new AnthropicBrain(config.model) : new MockBrain();
  if (!hasCreds) {
    console.warn(
      "[999] No ANTHROPIC credential found — running the stub brain. Set ANTHROPIC_API_KEY to enable the real agent.",
    );
  }

  const engine = new TaskEngine(new TaskStore(path.join(config.stateDir, "tasks.json")));

  // Subagents run with a tool set that cannot spawn further subagents (depth-1 cap).
  const subTools = new ToolRegistry({ fs, shell, browser });
  const spawnSubagent = async (goal: string, maxSteps?: number, parentId?: string): Promise<string> => {
    const child = engine.create(goal, maxSteps ?? config.maxSteps, parentId);
    await new AgentLoop(child.id, { brain, tools: subTools, engine }).run();
    const done = engine.get(child.id);
    if (!done) return "subagent task vanished";
    if (done.status === "completed") return done.result ?? "(subagent completed without a summary)";
    return `subagent did not complete (status: ${done.status}${done.error ? `: ${done.error}` : ""})`;
  };
  const tools = new ToolRegistry({ fs, shell, browser, spawnSubagent });

  // Reconcile tasks left mid-flight by a previous process: their loops are gone.
  for (const t of engine.list()) {
    if (t.status === "running") {
      engine.fail(t.id, "interrupted by server restart (retry to run again)");
    }
  }

  const orchestrator = new Orchestrator({
    engine,
    makeLoop: (taskId) => new AgentLoop(taskId, { brain, tools, engine }),
    maxConcurrent: config.maxConcurrentTasks,
  });

  const goals = new GoalMonitor(
    new GoalStore(path.join(config.stateDir, "goals.json")),
    browser,
    { minIntervalSec: config.goalMinIntervalSec, defaultIntervalSec: config.goalDefaultIntervalSec },
  );
  goals.start();

  const app = createApp({ config, engine, orchestrator, goals, browser });
  app.listen(config.port, config.host, () => {
    console.log(`[999] agent-computer listening on http://${config.host}:${config.port}`);
    console.log(`[999] workspace: ${config.workspaceDir}  (quota ${config.workspaceQuotaBytes} bytes)`);
    console.log(
      `[999] model: ${config.model}  brain: ${brain.model}  browser: ${config.browser.headless ? "headless" : "headed"}  auth: ${config.apiToken ? "on" : "off"}  maxConcurrent: ${config.maxConcurrentTasks}`,
    );
  });
}

main().catch((err) => {
  console.error("[999] fatal:", err);
  process.exit(1);
});
