import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Shell, ShellError } from "../src/computer/shell";

async function cwd(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "999-sh-"));
}

test("runs an allowlisted command", async () => {
  const sh = new Shell({ cwd: await cwd(), allow: ["echo"], timeoutMs: 5000, maxOutputBytes: 10_000 });
  const r = await sh.run("echo", ["hello", "world"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "hello world");
});

test("rejects a command that is not allowlisted", async () => {
  const sh = new Shell({ cwd: await cwd(), allow: ["echo"], timeoutMs: 5000, maxOutputBytes: 10_000 });
  await assert.rejects(() => sh.run("bash", ["-c", "echo hi"]), ShellError);
});

test("rejects path separators in the command name", async () => {
  const sh = new Shell({ cwd: await cwd(), allow: ["echo"], timeoutMs: 5000, maxOutputBytes: 10_000 });
  await assert.rejects(() => sh.run("/bin/echo", ["hi"]), ShellError);
});

test("does not leak host secrets into the child environment", async () => {
  process.env.FAKE_SECRET_999 = "s3cr3t-value";
  try {
    const sh = new Shell({ cwd: await cwd(), allow: ["printenv"], timeoutMs: 5000, maxOutputBytes: 10_000 });
    const r = await sh.run("printenv", ["FAKE_SECRET_999"]);
    assert.ok(!r.stdout.includes("s3cr3t-value"), "secret should not be visible to the child");
  } finally {
    delete process.env.FAKE_SECRET_999;
  }
});

test("enforces a wall-clock timeout", async () => {
  const sh = new Shell({ cwd: await cwd(), allow: ["sleep"], timeoutMs: 150, maxOutputBytes: 10_000 });
  const r = await sh.run("sleep", ["5"]);
  assert.equal(r.timedOut, true);
});
