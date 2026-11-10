# Architecture — 999

This document explains **how 999 is built**: its layers, the responsibility of
each module, the agentic loop, the task state machine, how state is persisted,
and where the trust boundaries sit. For the threat model and the line-by-line
security review see [SECURITY.md](SECURITY.md); for how 999 relates to similar
projects see [LANDSCAPE.md](LANDSCAPE.md).

> 999 is a small, self-hostable **agent runtime**: you give it a goal and it
> works toward that goal by driving its own *computer* — a persistent browser, a
> sandboxed shell, and a jailed workspace filesystem — while a task engine records
> every step so you can watch, pause, resume, cancel, or retry.

---

## 1. Design principles

The whole system is shaped by five decisions:

1. **Least privilege at the tool boundary.** The model can only affect the world
   through tools, and every tool enforces its own limits *assuming the model (or
   the web) is adversarial*. Nothing trusts the model to behave.
2. **The control plane is separate from the agent.** An HTTP/orchestration layer
   owns *when* a task runs and *whether it may continue*; the agent loop owns
   *what the agent does*. They communicate only through the task engine.
3. **Everything the agent does is logged.** Each model turn and each tool call
   becomes an immutable line in the task's operation log — the audit trail.
4. **The brain is pluggable.** The loop depends on a `Brain` interface, not on
   the Anthropic SDK directly, so it runs offline (and under test) against a
   `MockBrain` with no network and no credential.
5. **Isolation is the container, not the allowlist.** The shell allowlist and
   path jail are defense-in-depth; the real sandbox boundary is the process
   (Docker). The code is honest about this everywhere.

---

## 2. Runtime topology (process view)

999 is a **single Node.js process** (Node ≥ 22, TypeScript run through `tsx`).
Inside it:

```
┌─────────────────────────────── node process ───────────────────────────────┐
│                                                                             │
│   Express HTTP server (loopback by default)  ──────────┐                    │
│        │  REST + SSE                                    │ emits "change"     │
│        ▼                                                │                    │
│   Orchestrator ──drives──▶ AgentLoop(s) ──▶ Brain (Anthropic SDK | Mock)    │
│        │  (concurrency cap + queue)   │                                     │
│        │                              ├──▶ ToolRegistry ──▶ "the computer":  │
│        │                              │        ├─ WorkspaceFS  (fs.promises) │
│        │                              │        ├─ Shell        (execFile)    │
│        │                              │        └─ BrowserSession (Playwright)│
│        ▼                              ▼                                      │
│   TaskEngine (EventEmitter) ◀─────────┘   GoalMonitor (setInterval timers)   │
│        │  single writer                         │                           │
│        ▼                                        ▼                           │
│   TaskStore (atomic JSON)                 GoalStore (atomic JSON)            │
│        └──────────────── WORKSPACE_DIR/.state/ ─────────────────┘           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

External processes: the **Chromium** browser launched by Playwright (a child
process with its own profile on disk) and the short-lived **child processes**
spawned by the shell tool. Everything else is in-process.

The recommended deployment wraps this entire process in a **container** (see the
`Dockerfile` / `docker-compose.yml`) running as a non-root user with only the
workspace writable — that container is the actual isolation boundary.

---

## 3. Layered architecture

```
        ┌──────────────────────────────────────────────┐
  UI     │  src/server/web/index.html  (Tasks + Goals)  │  vanilla HTML/JS, SSE
        └──────────────────────────────────────────────┘
                              │ HTTP (REST + Server-Sent Events)
        ┌──────────────────────────────────────────────┐
  Edge   │  src/server/api.ts                           │  auth · CSRF · rate-limit
        │  src/server/orchestrator.ts                  │  concurrency cap + queue
        └──────────────────────────────────────────────┘
                              │ create / control / subscribe
        ┌──────────────────────────────────────────────┐
  Core   │  src/agent/loop.ts   (the agentic loop)      │
        │  src/agent/brain.ts  (Anthropic | Mock)      │
        │  src/agent/tools.ts  (ToolRegistry)          │
        │  src/tasks/engine.ts (state + audit log)     │
        │  src/goals/monitor.ts (scheduler)            │
        └──────────────────────────────────────────────┘
                              │ act through sandboxed tools
        ┌──────────────────────────────────────────────┐
  Computer│  src/computer/files.ts   (jailed FS + quota)│
        │  src/computer/shell.ts   (allowlist, no sh)  │
        │  src/computer/browser.ts (Playwright + SSRF) │
        └──────────────────────────────────────────────┘
                              │ persist
        ┌──────────────────────────────────────────────┐
  State  │  src/tasks/store.ts · src/goals/store.ts     │  atomic JSON (tmp+rename)
        └──────────────────────────────────────────────┘
```

Dependencies point **downward only**. The core never imports the edge; the
computer never imports the core. `src/index.ts` is the composition root that
wires one of everything together at boot.

---

## 4. Module reference

### `src/config.ts` — env → typed `Config`
`loadConfig(env)` reads every setting from the environment with safe defaults and
returns a frozen-in-practice `Config` object threaded through the whole app.
Notable defaults: model `claude-opus-5-5`, `maxSteps` 24, `maxConcurrentTasks` 3,
`rateLimitPerMin` 120, `workspaceQuotaBytes` 50 MB, goal interval 300 s (floor
30 s), shell timeout 15 s / 100 KB output. The **default shell allowlist**
deliberately excludes interpreters (`node`, `python`, `sh`, …) and network tools
(`curl`, `wget`) — see the comment in the file for why.

### `src/tasks/` — the task domain
- **`types.ts`** — `Task`, `TaskStatus` (`planned | running | paused | completed
  | failed | cancelled`), `TaskControl` (`pause | cancel`), `OperationRecord`
  / `OperationKind`, and the `TERMINAL` set.
- **`store.ts`** — `TaskStore`: load/save the task array as JSON, written
  **atomically** (write to a temp file, then `rename`) so a crash never leaves a
  half-written store.
- **`engine.ts`** — `TaskEngine extends EventEmitter`, the **single writer** of
  task state. Every mutation updates the in-memory map, persists, and emits
  `"change"` with the task id (this is what the SSE endpoint streams). It exposes
  `create`, `appendLog`, `setStatus`, `incrementSteps`, `requestControl` /
  `consumeControl` (the cooperative pause/cancel channel), `complete`, `fail`,
  and `resetForRetry`.

### `src/goals/` — scheduled page monitoring
- **`types.ts`** — `Goal`, `GoalCondition` (`contains | absent | regex |
  price_below`, with an optional CSS `selector`), `GoalCheck` history entries.
- **`evaluate.ts`** — pure functions: `evaluateCondition(text, condition)` and
  `extractPrice(text)`. No I/O, fully unit-tested.
- **`store.ts`** — `GoalStore`, atomic JSON like `TaskStore`.
- **`monitor.ts`** — `GoalMonitor extends EventEmitter`: owns the `setInterval`
  timers (unref'd so they don't keep the process alive), runs a check by fetching
  the page text through a throwaway browser tab, evaluates the condition, appends
  to history (capped), and **fires an `alert` the first time** the condition is
  satisfied (`triggeredAt`). Emits `"change"` / `"alert"`.

### `src/computer/` — "the computer" the agent drives
- **`files.ts`** — `WorkspaceFS(root, quotaBytes)`: read/write/list confined to a
  workspace root by **two independent checks** — a lexical one (reject `..` and
  absolute paths) and a symlink one (realpath of the nearest existing ancestor
  must stay inside the realpath of the root). `fs_write` also enforces the byte
  **quota**; `remove(".")` on the root is refused.
- **`shell.ts`** — `Shell.run(command, args)`: an **allowlist** of bare
  executable names (path separators rejected), `execFile` with `shell: false`
  (so argv is never interpreted), a **scrubbed environment** (`PATH`/`HOME`/
  `LANG`/`TERM` only — keeps `ANTHROPIC_API_KEY` etc. out of child reach), a
  timeout, and an output cap. *This is defense-in-depth, not a jail* (see
  SECURITY.md §2).
- **`browser.ts`** — `BrowserSession`: a lazily-imported Playwright **persistent
  Chromium context** (profile on disk, so a human can sign in once and the agent
  reuses the session). SSRF defense is two-layer: a **pre-navigation DNS check**
  (every resolved address is tested against private/loopback/link-local/CGNAT/ULA
  ranges) *and* a **network-layer route guard** that blocks every request —
  top-level, redirect, or subresource — to a private-IP literal or `localhost`,
  closing the "public page 302-redirects to 169.254.169.254" metadata attack.

### `src/agent/` — the thinking part
- **`types.ts`** — the `Brain` interface (`respond(req) → AssistantTurn`), the
  conversation/assistant/tool-result shapes, and `ToolSpec`.
- **`brain.ts`** — `AnthropicBrain` calls `messages.create` with adaptive
  thinking and `strict` tools, and maps content + stop reason into an
  `AssistantTurn` while **preserving the raw assistant content** (including
  thinking blocks) for correct replay. `MockBrain` plays a queued script for
  offline runs and tests.
- **`tools.ts`** — `ToolRegistry`: the 12 tools (below), each a `{spec, handler}`
  pair. `execute()` validates input defensively (the JSON schema is advisory —
  model output is never trusted), runs the handler, and converts any throw into
  an `isError` outcome rather than crashing the loop. Two tools return a
  **control signal** (`task_complete` → complete, `request_human_takeover` →
  takeover) that the loop acts on.
- **`loop.ts`** — `AgentLoop`, the manual agentic loop (§5).

### `src/server/` — the control plane
- **`orchestrator.ts`** — enforces the **concurrency cap**: at most
  `MAX_CONCURRENT_TASKS` loops run at once, the rest queue; `.finally()` drains
  the queue when a loop settles. Owns create / pause / cancel / resume / retry at
  the task level.
- **`api.ts`** — the Express app: JSON body cap, **per-IP rate limiting**,
  optional **bearer auth** (`timingSafeEqual`, also accepted as `?token=` for
  SSE), **CSRF/Origin check** on mutating calls, the task + goal routes, the
  **SSE stream** (`GET /api/tasks/:id/events`), static UI, and a JSON error
  handler.
- **`web/index.html`** — a dependency-free UI with Tasks and Goals tabs; the task
  detail view subscribes to the SSE stream and renders the operation log live.

### `src/index.ts` — composition root
`main()` builds the workspace FS (with quota), shell, browser, and brain (the
real one if a credential is present, otherwise the stub), constructs the engine,
wires the subagent-spawning closure (depth-1 capped), reconciles any tasks left
`running` by a previous crash back to `failed`, starts the orchestrator and goal
monitor, and listens.

---

## 5. The agentic loop

`AgentLoop.run()` ([src/agent/loop.ts](../src/agent/loop.ts)) is a **manual**
loop — 999 owns the control flow rather than delegating to an SDK runner, which
is what makes pause/cancel/audit-logging possible. One iteration:

```
        ┌──────────────────────────────────────────────────────────────┐
        │  consumeControl(taskId)                                       │
        │     cancel → status=cancelled, return                        │
        │     pause  → status=paused,    return                        │
        │  steps >= maxSteps → fail("reached max steps"), return       │
        ├──────────────────────────────────────────────────────────────┤
        │  turn = brain.respond({ system, history, tools })            │
        │  history.push(assistant raw content)   ← preserved verbatim   │
        │  log model text (kind="model")                               │
        │  stopReason == refusal → fail, return                        │
        ├──────────────────────────────────────────────────────────────┤
        │  toolUses = turn.blocks where type=="tool_use"               │
        │     none → complete(say), return     ← model is done talking  │
        │     stopReason==max_tokens mid-call → fail, return           │
        │  for each toolUse:                                            │
        │     log tool_call → execute → log tool_result / error        │
        │     collect ToolResult + any control signal                  │
        │  history.push(user: toolResults)                             │
        │  incrementSteps()                                            │
        │     control complete  → complete(summary), return            │
        │     control takeover  → status=paused + human log, return    │
        └──────────────────────────────────────────────────────────────┘
                              │ loop
                              ▼
```

Key properties:

- **Resumable in-process.** The loop holds `history` and a `started` flag, so a
  paused task resumed from the same process continues with full context; the
  conversation is not re-derived from the log.
- **Cooperative control.** Pause/cancel are *requests* consumed at the top of
  each iteration — the loop never interrupts a tool mid-flight, so state stays
  consistent.
- **Faithful replay.** The raw assistant content (including thinking blocks) is
  pushed back verbatim, which is what the Anthropic API requires for a correct
  multi-turn tool conversation.
- **Errors don't crash the loop.** A tool throw becomes an `isError` tool result
  fed back to the model (so it can adapt); only an exception *outside* tool
  execution fails the task.

### Subagents
`spawn_subagent` lets a top-level agent delegate a self-contained sub-goal. The
subagent gets its own task (`parentId` set) and its own `AgentLoop`, sharing the
same computer, and runs to completion before returning its summary. Subagents are
**depth-1 capped** (their tool context has no `spawnSubagent`) and run
sequentially.

---

## 6. Task state machine

```
                      ┌─────────┐   retry    ┌───────────┐
        create ─────▶ │ planned │ ◀───────── │ completed │
                      └────┬────┘            │  failed   │
                     run   │                 │ cancelled │ (TERMINAL)
                           ▼                 └───────────┘
                      ┌─────────┐                 ▲
         ┌──pause───▶ │ running │ ──complete─────┤
         │            └──┬───┬──┘ ──fail─────────┤
         │   resume      │   │    ──cancel───────┘
      ┌──┴────┐ ◀────────┘   │
      │paused │              └── takeover ──▶ paused (awaiting human)
      └───────┘
```

- `planned` → `running` when the orchestrator launches it (immediately, or after
  it leaves the queue).
- `running` → `paused` on a cooperative pause **or** a human-takeover request.
- `paused` → `running` on resume (in-process context preserved).
- `running` → `completed | failed | cancelled` — the **terminal** states.
- A terminal task only moves again via **retry**, which `resetForRetry` returns
  to `planned` (steps/result/error cleared) for a fresh run.

Every transition is appended to the task's operation log as a `status` record,
so the history is reconstructable from the log alone.

---

## 7. The operation log (audit trail)

Each `Task` carries an append-only `log: OperationRecord[]`. Records are typed by
`OperationKind`:

| kind | written when |
|---|---|
| `info` | lifecycle notes (created, control requested, retry) |
| `status` | every state transition (`from → to`) |
| `model` | the agent's own text for a turn (its visible reasoning) |
| `tool_call` | a tool is about to run, with its input |
| `tool_result` | a tool returned (output truncated to 2 KB in the log) |
| `human` | a human-takeover hand-off |
| `error` | a tool error or a failing turn |

This log is the single source of truth for "what did the agent do", it is what
the SSE stream pushes to the UI, and it is persisted with the task so it survives
a restart.

---

## 8. Goals & monitoring subsystem

Independent of the task loop. A `Goal` pairs a public URL with a `GoalCondition`
and a check interval. `GoalMonitor` schedules an interval timer per active goal;
each tick fetches the page text (optionally scoped by a CSS selector) through a
throwaway browser tab, runs the pure `evaluateCondition`, and records a
`GoalCheck`. The **first** time the condition is satisfied it stamps
`triggeredAt` and emits an `alert`. Conditions:

- `contains` / `absent` — substring present / not present
- `regex` — pattern matches
- `price_below` — `extractPrice(text)` is under a numeric threshold

Goals can be paused, resumed, checked on demand, and deleted over the API.

---

## 9. Persistence

All durable state lives under `WORKSPACE_DIR/.state/` as plain JSON:

- `tasks.json` — the full task list including operation logs.
- `goals.json` — the goal list including check history.
- `browser-profile/` — the persistent Chromium profile (cookies, local storage).

`TaskStore`/`GoalStore` write **atomically** (temp file + `rename`) so a crash
never corrupts the store. On boot the engine loads the stores back into memory and
reconciles any task still marked `running` (a process died mid-task) to `failed`.
There is no database — this is deliberately a single-node, single-user runtime.

> `.state/` holds cookies, logs, and fetched web content. Treat it as sensitive
> (see SECURITY.md §5).

---

## 10. HTTP API & streaming

REST over Express 5, input validated with zod. The mutating routes sit behind
rate-limiting, optional bearer auth, and the CSRF/Origin check. Summary:

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness + model + whether Playwright is importable |
| `GET /api/tasks` · `POST /api/tasks` | list · create+start |
| `GET /api/tasks/:id` | full task incl. operation log |
| `POST /api/tasks/:id/{pause,resume,cancel,retry}` | lifecycle control |
| `GET /api/tasks/:id/events` | **SSE** live task stream |
| `GET` · `POST /api/goals` | list · create a monitor |
| `POST /api/goals/:id/{check,pause,resume}` · `DELETE /api/goals/:id` | monitor control |

**SSE**: the endpoint subscribes to the engine's `"change"` event, writes
`data: <task json>` on each change for the matching id, sends a 15 s keep-alive
ping, and cleans up its listener when the client disconnects. This is why the UI
updates the moment the agent does something, without polling.

---

## 11. Concurrency & orchestration

The `Orchestrator` is the only thing that starts loops. It keeps a `running`
count and a `queue`; `enqueueOrLaunch` starts a task immediately if under the cap
or parks it as `planned` otherwise. A `.finally()` on each loop decrements the
count and `drain()`s the next queued task. Cancel removes a still-queued task
without ever running it; resume refuses (409) if resuming would exceed the cap.
This bounds how many browsers/model calls are in flight at once.

---

## 12. Security boundaries (summary)

The trust model (full version in [SECURITY.md](SECURITY.md)):

| Party | Trust |
|---|---|
| Operator (you) | trusted |
| The model / agent | **semi-trusted** — steerable by untrusted input; every tool enforces its own limits |
| Web content & tool output | **untrusted** — data, may try to hijack the agent |
| Other users on the box | untrusted |

The boundaries, and the module that enforces each:

- **Filesystem** → `files.ts` (lexical + symlink jail, byte quota).
- **Process execution** → `shell.ts` (allowlist, no shell, scrubbed env) — backed
  by the container for real isolation.
- **Network / SSRF** → `browser.ts` (DNS check + route guard) — backed by an
  egress firewall to fully close DNS-rebinding residuals.
- **API** → `api.ts` (auth, CSRF, rate-limit, body cap).
- **Secrets** → scrubbed from shell children, never written to logs.
- **Prompt injection** → structurally bounded: the agent can only do what a tool
  allows, takeover gates sensitive actions, and `maxSteps` bounds a runaway.

---

## 13. Configuration surface

Everything is environment-driven (see [`.env.example`](../.env.example)). No
secret is ever required to boot — without an Anthropic credential the app runs a
stub brain so the server, UI, SSE, and plumbing can be smoke-tested offline. The
one rule to remember: **set `API_TOKEN` before you change `HOST` off loopback.**

---

## 14. Extensibility — where to plug in

- **A different model / provider** → implement the `Brain` interface
  ([src/agent/types.ts](../src/agent/types.ts)); the loop is unchanged.
- **A new capability** → add a `{spec, handler}` to `buildTools()` in
  [src/agent/tools.ts](../src/agent/tools.ts). Enforce the capability's limits in
  the handler, assuming the input is adversarial.
- **A real sandbox provider** (E2B, Daytona, Firecracker) → implement the `Shell`
  / `BrowserSession` surface against it; the tool layer doesn't change.
- **A new goal condition** → extend `GoalConditionType` and `evaluateCondition`.
- **Alert delivery** (webhook/email) → subscribe to `GoalMonitor`'s `"alert"`
  event in `index.ts`.

---

## 15. Testing strategy

Tests run on the Node built-in test runner through `tsx`, with **no network and
no Chromium required** — the `MockBrain` and pure evaluators make the core
fully testable offline. Coverage spans the five load-bearing units:

- `files.test.ts` — write/read, `..` traversal, symlink escape, remove-root,
  quota enforcement.
- `shell.test.ts` — allowlist, path-separator rejection, env scrubbing, timeout.
- `engine.test.ts` — lifecycle, control request/consume, persistence, retry.
- `loop.test.ts` — completion + audit log, tool-error handling, cancel,
  `task_complete`.
- `goals.test.ts` — `evaluateCondition`, `extractPrice`, monitor check/alert/
  persist, input validation.

```bash
pnpm typecheck      # tsc --noEmit
pnpm test           # the suite above; offline
```

---

## 16. Known limitations

- Single-node, single-process, JSON-on-disk — not built for multi-tenant scale.
- Subagents run sequentially and are depth-1 capped.
- DNS-rebinding on subresources and `BROWSER_ALLOW_PRIVATE_NETWORK=true` are only
  fully closed by an egress firewall (SECURITY.md §3).
- The shell allowlist is not a sandbox; run the process in the provided container
  for a real boundary.

See the Roadmap in [README.md](../README.md) for what's intended next.
