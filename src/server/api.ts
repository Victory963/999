import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import type { BrowserSession } from "../computer/browser";
import type { Config } from "../config";
import type { GoalMonitor } from "../goals/monitor";
import { GoalError } from "../goals/monitor";
import type { TaskEngine } from "../tasks/engine";
import type { Task } from "../tasks/types";
import type { Orchestrator } from "./orchestrator";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");

const CreateTaskBody = z.object({
  goal: z.string().trim().min(1).max(4000),
  maxSteps: z.number().int().min(1).max(100).optional(),
});

const CreateGoalBody = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1).max(2000),
  condition: z.object({
    type: z.enum(["contains", "absent", "regex", "price_below"]),
    value: z.string().min(1).max(500),
    selector: z.string().max(200).optional(),
  }),
  intervalSec: z.number().int().min(5).max(86_400).optional(),
});

function tokenOk(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function summary(t: Task) {
  return {
    id: t.id,
    goal: t.goal,
    status: t.status,
    parentId: t.parentId,
    steps: t.steps,
    maxSteps: t.maxSteps,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    operations: t.log.length,
    result: t.result,
    error: t.error,
  };
}

export interface ApiDeps {
  config: Config;
  engine: TaskEngine;
  orchestrator: Orchestrator;
  goals: GoalMonitor;
  browser: BrowserSession;
}

export function createApp(deps: ApiDeps): express.Express {
  const { config, engine, orchestrator, goals, browser } = deps;
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // --- Rate limiting (fixed window, per client IP) ---
  const hits = new Map<string, { count: number; windowStart: number }>();
  app.use("/api", (req, res, next) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    if (hits.size > 10_000) hits.clear();
    const entry = hits.get(ip);
    if (!entry || now - entry.windowStart >= 60_000) {
      hits.set(ip, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
      if (entry.count > config.rateLimitPerMin) {
        res.status(429).json({ error: "rate limit exceeded" });
        return;
      }
    }
    next();
  });

  // --- Auth: bearer token (header) or ?token= (for EventSource, which cannot set headers) ---
  app.use("/api", (req, res, next) => {
    if (!config.apiToken) return next();
    const header = req.header("authorization");
    const fromHeader = header ? /^Bearer (.+)$/.exec(header)?.[1] : undefined;
    const fromQuery = typeof req.query.token === "string" ? req.query.token : undefined;
    if (tokenOk(fromHeader ?? fromQuery, config.apiToken)) return next();
    res.status(401).json({ error: "unauthorized" });
  });

  // --- CSRF: for mutating requests, a browser Origin (if present) must be allowlisted ---
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.header("origin");
    if (origin && !config.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "origin not allowed" });
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    void browser.chromiumReady().then((chromiumReady) => {
      res.json({ status: "ok", runtime: "999", model: config.model, chromiumReady });
    });
  });

  // ---------- Tasks ----------
  app.get("/api/tasks", (_req, res) => {
    res.json(engine.list().map(summary));
  });

  app.get("/api/tasks/:id", (req, res) => {
    const t = engine.get(req.params.id);
    if (!t) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    res.json(t);
  });

  // Server-Sent Events: live stream of a task's state.
  app.get("/api/tasks/:id/events", (req, res) => {
    const id = req.params.id;
    if (!engine.get(id)) {
      res.status(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = () => {
      const t = engine.get(id);
      if (t) res.write(`data: ${JSON.stringify(t)}\n\n`);
    };
    send();
    const onChange = (changedId: string) => {
      if (changedId === id) send();
    };
    engine.on("change", onChange);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    ping.unref?.();
    req.on("close", () => {
      engine.off("change", onChange);
      clearInterval(ping);
    });
  });

  app.post("/api/tasks", (req, res) => {
    const parsed = CreateTaskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const task = orchestrator.create(parsed.data.goal, parsed.data.maxSteps ?? config.maxSteps);
    res.status(201).json(task);
  });

  const taskAction = (name: "pause" | "resume" | "cancel" | "retry") => {
    app.post(`/api/tasks/:id/${name}`, (req, res) => {
      if (!engine.get(req.params.id)) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      try {
        orchestrator[name](req.params.id);
        res.json({ ok: true });
      } catch (err) {
        res.status(409).json({ error: (err as Error).message });
      }
    });
  };
  taskAction("pause");
  taskAction("resume");
  taskAction("cancel");
  taskAction("retry");

  // ---------- Goals ----------
  app.get("/api/goals", (_req, res) => {
    res.json(goals.list());
  });

  app.get("/api/goals/:id", (req, res) => {
    const g = goals.get(req.params.id);
    if (!g) {
      res.status(404).json({ error: "goal not found" });
      return;
    }
    res.json(g);
  });

  app.post("/api/goals", (req, res) => {
    const parsed = CreateGoalBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    try {
      res.status(201).json(goals.create(parsed.data));
    } catch (err) {
      if (err instanceof GoalError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.post("/api/goals/:id/check", async (req, res) => {
    if (!goals.get(req.params.id)) {
      res.status(404).json({ error: "goal not found" });
      return;
    }
    res.json(await goals.checkNow(req.params.id));
  });

  for (const name of ["pause", "resume"] as const) {
    app.post(`/api/goals/:id/${name}`, (req, res) => {
      if (!goals.get(req.params.id)) {
        res.status(404).json({ error: "goal not found" });
        return;
      }
      res.json(goals[name](req.params.id));
    });
  }

  app.delete("/api/goals/:id", (req, res) => {
    if (!goals.get(req.params.id)) {
      res.status(404).json({ error: "goal not found" });
      return;
    }
    goals.remove(req.params.id);
    res.json({ ok: true });
  });

  app.use(express.static(WEB_DIR));

  // JSON error handler (e.g. malformed request body).
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err.message });
  });

  return app;
}
