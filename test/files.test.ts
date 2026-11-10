import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkspaceError, WorkspaceFS } from "../src/computer/files";

async function tmpRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "999-fs-"));
}

test("writes and reads within the workspace", async () => {
  const fs = new WorkspaceFS(await tmpRoot());
  await fs.init();
  await fs.write("notes/a.txt", "hello");
  assert.equal(await fs.read("notes/a.txt"), "hello");
  const entries = await fs.list("notes");
  assert.deepEqual(entries.map((e) => e.name), ["a.txt"]);
});

test("rejects path traversal and absolute paths", async () => {
  const fs = new WorkspaceFS(await tmpRoot());
  await fs.init();
  await assert.rejects(() => fs.write("../escape.txt", "x"), WorkspaceError);
  await assert.rejects(() => fs.read("../../etc/passwd"), WorkspaceError);
  await assert.rejects(() => fs.read("/etc/passwd"), WorkspaceError);
});

test("rejects reads through a symlink that escapes the workspace", async () => {
  const root = await tmpRoot();
  const fs = new WorkspaceFS(root);
  await fs.init();
  const outside = await tmpRoot();
  await writeFile(path.join(outside, "secret.txt"), "top secret");
  await symlink(outside, path.join(root, "link"));
  await assert.rejects(() => fs.read("link/secret.txt"), WorkspaceError);
});

test("refuses to remove the workspace root", async () => {
  const fs = new WorkspaceFS(await tmpRoot());
  await fs.init();
  await assert.rejects(() => fs.remove("."), WorkspaceError);
});

test("enforces the workspace byte quota", async () => {
  const fs = new WorkspaceFS(await tmpRoot(), 50);
  await fs.init();
  await fs.write("a.txt", "x".repeat(40)); // under quota
  await assert.rejects(() => fs.write("b.txt", "y".repeat(40)), WorkspaceError); // would exceed 50
});
