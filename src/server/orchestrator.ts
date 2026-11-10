import type { AgentLoop } from "../agent/loop";
import type { TaskEngine } from "../tasks/engine";
import type { Task } from "../tasks/types";

export interface OrchestratorDeps {
  engine: TaskEngine;
  makeLoop: (taskId: string) => AgentLoop;
  maxConcurrent: number;
}

/**
 * Bridges the HTTP control plane and the agent loops. Loops run in the
 * background; at most `maxConcurrent` run at once, with the rest queued as
 * "planned". A loop instance is kept per task so a paused task can be resumed
 * in-process with its conversation intact.
 */
export class Orchestrator {
  private readonly loops = new Map<string, AgentLoop>();
  private readonly queue: string[] = [];
  private running = 0;

  constructor(private readonly deps: OrchestratorDeps) {}

  private launch(taskId: string, loop?: AgentLoop): void {
    this.running += 1;
    const l = loop ?? this.deps.makeLoop(taskId);
    this.loops.set(taskId, l);
    void l
      .run()
      .catch((err) => this.deps.engine.fail(taskId, (err as Error).message))
      .finally(() => {
        this.running -= 1;
        this.drain();
      });
  }

  private drain(): void {
    while (this.running < this.deps.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const t = this.deps.engine.get(id);
      if (!t || t.status !== "planned") continue; // cancelled/removed while queued
      this.launch(id);
    }
  }

  private enqueueOrLaunch(taskId: string): void {
    if (this.running < this.deps.maxConcurrent) {
      this.launch(taskId);
    } else {
      this.queue.push(taskId);
      this.deps.engine.appendLog(taskId, "info", "queued — concurrency limit reached");
    }
  }

  create(goal: string, maxSteps: number): Task {
    const task = this.deps.engine.create(goal, maxSteps);
    this.enqueueOrLaunch(task.id);
    return task;
  }

  pause(id: string): void {
    this.deps.engine.requestControl(id, "pause");
  }

  cancel(id: string): void {
    const i = this.queue.indexOf(id);
    if (i >= 0) {
      // Only queued, never launched — cancel without waiting for a loop.
      this.queue.splice(i, 1);
      this.deps.engine.setStatus(id, "cancelled");
      return;
    }
    this.deps.engine.requestControl(id, "cancel");
  }

  resume(id: string): void {
    const task = this.deps.engine.get(id);
    if (!task) throw new Error("task not found");
    if (task.status !== "paused") throw new Error(`cannot resume a ${task.status} task`);
    if (this.running >= this.deps.maxConcurrent) {
      throw new Error("at capacity — try again when a running task finishes");
    }
    this.launch(id, this.loops.get(id));
  }

  retry(id: string): void {
    const task = this.deps.engine.get(id);
    if (!task) throw new Error("task not found");
    this.deps.engine.resetForRetry(id);
    this.loops.delete(id); // force a fresh loop with fresh context
    this.enqueueOrLaunch(id);
  }
}
