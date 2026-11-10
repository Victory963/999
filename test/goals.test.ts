import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BrowserSession } from "../src/computer/browser";
import { evaluateCondition, extractPrice } from "../src/goals/evaluate";
import { GoalError, GoalMonitor } from "../src/goals/monitor";
import { GoalStore } from "../src/goals/store";

test("evaluateCondition covers every condition type", () => {
  assert.equal(evaluateCondition("hello world", { type: "contains", value: "world" }).ok, true);
  assert.equal(evaluateCondition("hello", { type: "contains", value: "xyz" }).ok, false);
  assert.equal(evaluateCondition("in stock", { type: "absent", value: "sold out" }).ok, true);
  assert.equal(evaluateCondition("sold out", { type: "absent", value: "sold out" }).ok, false);
  assert.equal(evaluateCondition("v1.2.3 released", { type: "regex", value: "v\\d+\\.\\d+" }).ok, true);
  assert.equal(evaluateCondition("price $9.99", { type: "price_below", value: "10" }).ok, true);
  assert.equal(evaluateCondition("price $19.99", { type: "price_below", value: "10" }).ok, false);
});

test("extractPrice finds a price or returns null", () => {
  assert.equal(extractPrice("Now only $1,299.00!"), 1299);
  assert.equal(extractPrice("no price on this page"), null);
});

async function storeFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "999-goal-"));
  return path.join(dir, "goals.json");
}

const fakeBrowser = {
  fetchText: async () => ({ url: "https://x", status: 200, title: "t", text: "price $9.99, in stock" }),
} as unknown as BrowserSession;

test("monitor checks, alerts on first match, and persists", async () => {
  const store = new GoalStore(await storeFile());
  const mon = new GoalMonitor(store, fakeBrowser, { minIntervalSec: 5, defaultIntervalSec: 300 });
  let alerted = false;
  mon.on("alert", () => {
    alerted = true;
  });
  const g = mon.create({ name: "watch", url: "https://example.com", condition: { type: "price_below", value: "10" } });
  assert.equal(g.status, "active");

  const check = await mon.checkNow(g.id);
  assert.equal(check.ok, true);
  assert.equal(alerted, true);
  assert.ok(mon.get(g.id)?.triggeredAt);
  mon.stopAll();
});

test("monitor validates input", async () => {
  const mon = new GoalMonitor(new GoalStore(await storeFile()), fakeBrowser, { minIntervalSec: 5, defaultIntervalSec: 300 });
  assert.throws(() => mon.create({ name: "", url: "https://x", condition: { type: "contains", value: "a" } }), GoalError);
  assert.throws(() => mon.create({ name: "n", url: "not a url", condition: { type: "contains", value: "a" } }), GoalError);
  mon.stopAll();
});
