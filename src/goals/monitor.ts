import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { BrowserSession } from "../computer/browser";
import { evaluateCondition } from "./evaluate";
import type { GoalStore } from "./store";
import type { Goal, GoalCheck, GoalCondition, GoalConditionType } from "./types";

const CONDITION_TYPES: ReadonlySet<GoalConditionType> = new Set([
  "contains",
  "absent",
  "regex",
  "price_below",
]);

const MAX_HISTORY = 20;

export interface GoalMonitorOptions {
  minIntervalSec: number;
  defaultIntervalSec: number;
}

export interface CreateGoalInput {
  name: string;
  url: string;
  condition: GoalCondition;
  intervalSec?: number;
}

export class GoalError extends Error {}

/**
 * Periodically re-checks public web pages for a condition (text present/absent,
 * regex, or price below a threshold) and raises an alert the first time it is
 * met. Each goal runs on its own interval; checks use a throwaway browser tab so
 * they never disturb an agent's main page. Emits `"change"` (goal id) and
 * `"alert"` ({ goal, detail }).
 */
export class GoalMonitor extends EventEmitter {
  private readonly goals = new Map<string, Goal>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: GoalStore,
    private readonly browser: BrowserSession,
    private readonly opts: GoalMonitorOptions,
  ) {
    super();
    for (const g of store.load()) this.goals.set(g.id, g);
  }

  /** Begin scheduling all active goals (call once at boot). */
  start(): void {
    for (const g of this.goals.values()) {
      if (g.status === "active") this.schedule(g.id);
    }
  }

  stopAll(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  list(): Goal[] {
    return [...this.goals.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
  }

  get(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  create(input: CreateGoalInput): Goal {
    const name = (input.name ?? "").trim();
    if (!name) throw new GoalError("name is required");
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new GoalError("url must be a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new GoalError("url must be http(s)");
    }
    if (!input.condition || !CONDITION_TYPES.has(input.condition.type)) {
      throw new GoalError("condition.type must be one of: contains, absent, regex, price_below");
    }
    if (typeof input.condition.value !== "string" || input.condition.value === "") {
      throw new GoalError("condition.value is required");
    }
    const intervalSec = Math.max(this.opts.minIntervalSec, input.intervalSec ?? this.opts.defaultIntervalSec);
    const now = new Date().toISOString();
    const goal: Goal = {
      id: randomUUID(),
      name,
      url: url.toString(),
      condition: {
        type: input.condition.type,
        value: input.condition.value,
        ...(input.condition.selector ? { selector: input.condition.selector } : {}),
      },
      intervalSec,
      status: "active",
      createdAt: now,
      updatedAt: now,
      checks: [],
    };
    this.goals.set(goal.id, goal);
    this.persist();
    this.schedule(goal.id);
    this.emit("change", goal.id);
    return goal;
  }

  pause(id: string): Goal {
    const g = this.require(id);
    g.status = "paused";
    g.updatedAt = new Date().toISOString();
    this.clearTimer(id);
    this.persist();
    this.emit("change", id);
    return g;
  }

  resume(id: string): Goal {
    const g = this.require(id);
    g.status = "active";
    g.updatedAt = new Date().toISOString();
    this.schedule(id);
    this.persist();
    this.emit("change", id);
    return g;
  }

  remove(id: string): void {
    this.require(id);
    this.clearTimer(id);
    this.goals.delete(id);
    this.persist();
    this.emit("change", id);
  }

  /** Run a single check immediately and return it. */
  async checkNow(id: string): Promise<GoalCheck> {
    return this.runCheck(id);
  }

  private require(id: string): Goal {
    const g = this.goals.get(id);
    if (!g) throw new GoalError(`goal not found: ${id}`);
    return g;
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearInterval(t);
      this.timers.delete(id);
    }
  }

  private schedule(id: string): void {
    this.clearTimer(id);
    const g = this.goals.get(id);
    if (!g) return;
    const sec = Math.max(this.opts.minIntervalSec, g.intervalSec);
    const timer = setInterval(() => void this.runCheck(id), sec * 1000);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private async runCheck(id: string): Promise<GoalCheck> {
    const g = this.goals.get(id);
    if (!g) return { at: new Date().toISOString(), ok: false, detail: "goal removed" };
    const now = new Date().toISOString();
    let check: GoalCheck;
    try {
      const { text } = await this.browser.fetchText(g.url, g.condition.selector);
      const { ok, detail } = evaluateCondition(text, g.condition);
      check = { at: now, ok, detail };
      if (ok && !g.triggeredAt) {
        g.triggeredAt = now;
        console.log(`[999][goal] ALERT "${g.name}": ${detail}`);
        this.emit("alert", { goal: g, detail });
      }
      g.lastOk = ok;
    } catch (err) {
      check = { at: now, ok: false, detail: "check failed", error: (err as Error).message };
    }
    g.lastCheckedAt = now;
    g.updatedAt = now;
    g.checks.push(check);
    if (g.checks.length > MAX_HISTORY) g.checks = g.checks.slice(-MAX_HISTORY);
    this.persist();
    this.emit("change", id);
    return check;
  }

  private persist(): void {
    this.store.save([...this.goals.values()]);
  }
}
