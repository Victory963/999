import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Goal } from "./types";

/** Atomic JSON store for goals (same approach as the task store). */
export class GoalStore {
  constructor(private readonly file: string) {}

  load(): Goal[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(parsed) ? (parsed as Goal[]) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  save(goals: Goal[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(goals, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
}
