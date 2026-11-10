import { promises as fs } from "node:fs";
import path from "node:path";

export class WorkspaceError extends Error {}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "other";
}

/**
 * The agent's filesystem, jailed to a single workspace root.
 *
 * Two layers of containment:
 *  1. Lexical — `path.resolve` + `path.relative` reject any path that escapes
 *     the root (`..`, absolute paths).
 *  2. Symlink — the realpath of the nearest existing ancestor must stay inside
 *     the realpath of the root, so a symlink inside the workspace cannot be used
 *     to read or write outside it.
 */
export class WorkspaceFS {
  private usedBytes = 0;

  constructor(
    private readonly root: string,
    /** 0 = unlimited. */
    private readonly quotaBytes = 0,
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    this.usedBytes = await this.duBytes(this.root);
  }

  private async duBytes(dir: string): Promise<number> {
    let total = 0;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += await this.duBytes(full);
      else if (e.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch {
          /* ignore unreadable entry */
        }
      }
    }
    return total;
  }

  private resolveLexical(p: string): string {
    const target = path.resolve(this.root, p);
    const rel = path.relative(this.root, target);
    if (
      rel !== "" &&
      (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
    ) {
      throw new WorkspaceError(`path escapes workspace: ${p}`);
    }
    return target;
  }

  private async assertRealContained(target: string): Promise<void> {
    const realRoot = await fs.realpath(this.root);
    let probe = target;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const rel = path.relative(realRoot, real);
        if (
          rel !== "" &&
          (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
        ) {
          throw new WorkspaceError(`path escapes workspace via symlink: ${target}`);
        }
        return;
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          const parent = path.dirname(probe);
          if (parent === probe) return; // lexical check already vetted this
          probe = parent;
          continue;
        }
        throw err;
      }
    }
  }

  private async safe(p: string): Promise<string> {
    const target = this.resolveLexical(p);
    await this.assertRealContained(target);
    return target;
  }

  async read(p: string): Promise<string> {
    return fs.readFile(await this.safe(p), "utf8");
  }

  async write(p: string, content: string): Promise<void> {
    const target = await this.safe(p);
    const newSize = Buffer.byteLength(content);
    let oldSize = 0;
    try {
      const st = await fs.stat(target);
      if (st.isFile()) oldSize = st.size;
    } catch {
      /* new file */
    }
    if (this.quotaBytes > 0 && this.usedBytes - oldSize + newSize > this.quotaBytes) {
      throw new WorkspaceError(
        `workspace quota exceeded: this write would exceed the ${this.quotaBytes}-byte limit`,
      );
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.assertRealContained(target); // re-check: mkdir may have followed a link
    await fs.writeFile(target, content, "utf8");
    this.usedBytes = Math.max(0, this.usedBytes - oldSize + newSize);
  }

  async list(p = "."): Promise<DirEntry[]> {
    const entries = await fs.readdir(await this.safe(p), { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
    }));
  }

  async mkdir(p: string): Promise<void> {
    await fs.mkdir(await this.safe(p), { recursive: true });
  }

  async remove(p: string): Promise<void> {
    const target = await this.safe(p);
    const realRoot = await fs.realpath(this.root);
    if (target === realRoot) throw new WorkspaceError("refusing to remove the workspace root");
    let freed = 0;
    try {
      const st = await fs.stat(target);
      freed = st.isDirectory() ? await this.duBytes(target) : st.size;
    } catch {
      /* ignore */
    }
    await fs.rm(target, { recursive: true, force: true });
    this.usedBytes = Math.max(0, this.usedBytes - freed);
  }

  async exists(p: string): Promise<boolean> {
    try {
      const target = await this.safe(p);
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  }
}
