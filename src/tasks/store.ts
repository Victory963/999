import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Task } from "./types";

/**
 * Durable task store: a single JSON file written atomically (tmp + rename).
 * Low-volume by design — the persistence requirement here is auditability, not
 * throughput, so synchronous atomic writes keep the state file always-consistent.
 */
export class TaskStore {
  constructor(private readonly file: string) {}

  load(): Task[] {
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as Task[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  save(tasks: Task[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
}
