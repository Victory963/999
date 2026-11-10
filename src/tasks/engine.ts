import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TaskStore } from "./store";
import {
  type OperationKind,
  type Task,
  type TaskControl,
  type TaskStatus,
  TERMINAL,
} from "./types";

export class TaskNotFound extends Error {
  constructor(id: string) {
    super(`task not found: ${id}`);
  }
}

/**
 * The task engine owns task state and its operation log. It is the single
 * writer: every mutation updates the in-memory map, persists atomically, and
 * emits a `"change"` event (with the task id) so the HTTP layer can stream
 * updates. The agent loop drives a task through it; the HTTP layer reads from it
 * and requests control changes (pause/cancel) that the loop cooperatively honours.
 */
export class TaskEngine extends EventEmitter {
  private readonly tasks = new Map<string, Task>();

  constructor(private readonly store: TaskStore) {
    super();
    for (const t of store.load()) this.tasks.set(t.id, t);
  }

  private persist(): void {
    this.store.save([...this.tasks.values()]);
  }

  private changed(id: string): void {
    this.persist();
    this.emit("change", id);
  }

  private require(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new TaskNotFound(id);
    return t;
  }

  private touch(t: Task): void {
    t.updatedAt = new Date().toISOString();
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  create(goal: string, maxSteps: number, parentId?: string): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      goal,
      status: "planned",
      createdAt: now,
      updatedAt: now,
      steps: 0,
      maxSteps,
      log: [],
      ...(parentId ? { parentId } : {}),
    };
    this.tasks.set(task.id, task);
    this.appendLog(task.id, "info", parentId ? `Subagent task created: ${goal}` : `Task created: ${goal}`);
    return task;
  }

  appendLog(id: string, kind: OperationKind, message: string, data?: unknown): void {
    const t = this.require(id);
    t.log.push({
      id: randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      kind,
      message,
      ...(data !== undefined ? { data } : {}),
    });
    this.touch(t);
    this.changed(id);
  }

  setStatus(
    id: string,
    status: TaskStatus,
    patch?: { result?: string; error?: string },
  ): Task {
    const t = this.require(id);
    const from = t.status;
    t.status = status;
    if (patch?.result !== undefined) t.result = patch.result;
    if (patch?.error !== undefined) t.error = patch.error;
    this.touch(t);
    this.appendLog(id, "status", `${from} → ${status}`);
    return t;
  }

  incrementSteps(id: string): number {
    const t = this.require(id);
    t.steps += 1;
    this.touch(t);
    this.changed(id);
    return t.steps;
  }

  requestControl(id: string, control: TaskControl): Task {
    const t = this.require(id);
    if (TERMINAL.has(t.status)) return t;
    t.control = control;
    this.touch(t);
    this.appendLog(id, "info", `control requested: ${control}`);
    return t;
  }

  consumeControl(id: string): TaskControl | undefined {
    const t = this.require(id);
    const c = t.control;
    if (c) {
      delete t.control;
      this.touch(t);
      this.changed(id);
    }
    return c;
  }

  complete(id: string, result: string): Task {
    return this.setStatus(id, "completed", { result });
  }

  fail(id: string, error: string): Task {
    return this.setStatus(id, "failed", { error });
  }

  resetForRetry(id: string): Task {
    const t = this.require(id);
    t.status = "planned";
    t.steps = 0;
    delete t.result;
    delete t.error;
    delete t.control;
    this.touch(t);
    this.appendLog(id, "info", "retry requested — task reset");
    return t;
  }
}
