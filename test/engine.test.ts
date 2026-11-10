import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TaskEngine } from "../src/tasks/engine";
import { TaskStore } from "../src/tasks/store";

async function storeFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "999-eng-"));
  return path.join(dir, "tasks.json");
}

test("lifecycle: create → running → complete", async () => {
  const engine = new TaskEngine(new TaskStore(await storeFile()));
  const t = engine.create("do a thing", 10);
  assert.equal(t.status, "planned");
  engine.setStatus(t.id, "running");
  engine.incrementSteps(t.id);
  engine.complete(t.id, "done");
  const done = engine.get(t.id);
  assert.equal(done?.status, "completed");
  assert.equal(done?.result, "done");
  assert.equal(done?.steps, 1);
});

test("control is requested then consumed once", async () => {
  const engine = new TaskEngine(new TaskStore(await storeFile()));
  const t = engine.create("x", 10);
  engine.setStatus(t.id, "running");
  engine.requestControl(t.id, "pause");
  assert.equal(engine.consumeControl(t.id), "pause");
  assert.equal(engine.consumeControl(t.id), undefined);
});

test("state persists across engine reloads", async () => {
  const file = await storeFile();
  const e1 = new TaskEngine(new TaskStore(file));
  const t = e1.create("persist me", 5);
  e1.complete(t.id, "ok");
  const e2 = new TaskEngine(new TaskStore(file));
  const loaded = e2.get(t.id);
  assert.ok(loaded);
  assert.equal(loaded?.status, "completed");
  assert.equal(loaded?.result, "ok");
});

test("retry resets a terminal task", async () => {
  const engine = new TaskEngine(new TaskStore(await storeFile()));
  const t = engine.create("y", 3);
  engine.fail(t.id, "boom");
  engine.resetForRetry(t.id);
  const r = engine.get(t.id);
  assert.equal(r?.status, "planned");
  assert.equal(r?.steps, 0);
  assert.equal(r?.error, undefined);
});
