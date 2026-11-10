import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MockBrain, textTurn, toolTurn } from "../src/agent/brain";
import { AgentLoop } from "../src/agent/loop";
import { ToolRegistry } from "../src/agent/tools";
import { BrowserSession } from "../src/computer/browser";
import { Shell } from "../src/computer/shell";
import { WorkspaceFS } from "../src/computer/files";
import { TaskEngine } from "../src/tasks/engine";
import { TaskStore } from "../src/tasks/store";
import type { BrowserConfig } from "../src/config";

const BROWSER_CFG: BrowserConfig = {
  headless: true,
  userDataDir: "/tmp/999-unused-profile",
  navigationTimeoutMs: 5000,
  allowPrivateNetwork: false,
};

async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "999-loop-"));
  const ws = path.join(dir, "workspace");
  const fs = new WorkspaceFS(ws);
  await fs.init();
  const shell = new Shell({ cwd: ws, allow: ["echo"], timeoutMs: 5000, maxOutputBytes: 10_000 });
  const browser = new BrowserSession(BROWSER_CFG, path.join(ws, "shots"));
  const tools = new ToolRegistry({ fs, shell, browser });
  const engine = new TaskEngine(new TaskStore(path.join(dir, "tasks.json")));
  return { fs, tools, engine };
}

test("loop drives tools to completion and records an audit log", async () => {
  const { fs, tools, engine } = await harness();
  const brain = new MockBrain([
    toolTurn("t1", "fs_write", { path: "out.txt", content: "written by agent" }, "Writing the file."),
    toolTurn("t2", "task_complete", { summary: "wrote out.txt" }),
  ]);
  const task = engine.create("write a file", 10);
  await new AgentLoop(task.id, { brain, tools, engine }).run();

  const done = engine.get(task.id);
  assert.equal(done?.status, "completed");
  assert.equal(done?.result, "wrote out.txt");
  assert.equal(await fs.read("out.txt"), "written by agent");
  assert.ok(done?.log.some((op) => op.kind === "tool_call" && op.message === "fs_write"));
  assert.ok(done?.log.some((op) => op.kind === "model"));
});

test("a tool error is fed back without crashing the loop", async () => {
  const { tools, engine } = await harness();
  const brain = new MockBrain([
    // reading a missing file errors; the agent then completes
    toolTurn("e1", "fs_read", { path: "does-not-exist.txt" }),
    toolTurn("e2", "task_complete", { summary: "handled the error" }),
  ]);
  const task = engine.create("read a missing file", 10);
  await new AgentLoop(task.id, { brain, tools, engine }).run();

  const done = engine.get(task.id);
  assert.equal(done?.status, "completed");
  assert.ok(done?.log.some((op) => op.kind === "error"));
});

test("loop honours a cancel request before calling the brain", async () => {
  const { tools, engine } = await harness();
  const brain = new MockBrain([textTurn("this turn should never run")]);
  const task = engine.create("cancel me", 10);
  engine.requestControl(task.id, "cancel");
  await new AgentLoop(task.id, { brain, tools, engine }).run();
  assert.equal(engine.get(task.id)?.status, "cancelled");
});

test("task_complete via mock yields the summary as the result", async () => {
  const { tools, engine } = await harness();
  const brain = new MockBrain([toolTurn("c1", "task_complete", { summary: "all done" })]);
  const task = engine.create("finish immediately", 5);
  await new AgentLoop(task.id, { brain, tools, engine }).run();
  const done = engine.get(task.id);
  assert.equal(done?.status, "completed");
  assert.equal(done?.result, "all done");
});
