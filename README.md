# 999 — a personal agent with its own computer

`999` is a small, self-hostable agent runtime: you give it a goal, and it works
toward it using its own **computer** — a persistent browser, a sandboxed shell,
and a jailed workspace filesystem — while a task engine records every step so you
can watch, pause, resume, cancel, or retry.

It is **original work** (MIT), written from scratch. It is *inspired by* the
"give an agent a computer" idea that projects like OpenMuse and Rakazo explore —
it is **not** a clone or reverse-engineering of any product. See
[docs/LANDSCAPE.md](docs/LANDSCAPE.md) for how it relates to that ecosystem.

> Status: alpha. Good for self-hosting, learning, and extending. Read
> [docs/SECURITY.md](docs/SECURITY.md) before exposing it to anything you care about.

---

## What it does

- **Its own computer.** The agent acts through tools:
  - `browser_*` — a persistent Chromium session (Playwright). The profile is on
    disk, so a human can **take over** to sign in once, and the agent reuses the
    session afterward.
  - `shell_run` — an allowlisted, no-shell-interpretation command runner.
  - `fs_*` — read/write/list inside a workspace the agent cannot escape.
- **A task engine.** Plan → run, with **pause / resume / cancel / retry**, a
  **concurrency cap** with queueing, and a full **operation log** (the audit
  trail) persisted to disk.
- **Goals & tracking.** Set a monitor on a public page — text present/absent, a
  regex, or a **price below a threshold** — and 999 re-checks it on an interval
  and raises an **alert** the first time the condition is met.
- **Subagents.** The agent can delegate a self-contained sub-goal to a
  short-lived subagent that shares the same computer (depth-1 capped).
- **Human-in-the-loop.** The agent calls `request_human_takeover` for logins,
  CAPTCHAs, payments, or any action it shouldn't take on its own; the task pauses
  until you resume it.
- **A pluggable brain.** Claude via the Anthropic SDK (adaptive thinking). With
  no credential it falls back to a harmless stub brain, so the server and UI run
  for a plumbing smoke test offline.
- **A minimal web UI + JSON API** (Tasks + Goals tabs) with **live SSE
  streaming** — watch each operation appear as the agent works.

## Requirements

- Node.js ≥ 22 (tested on 22.x)
- pnpm
- For the browser tools: Chromium, installed once with `pnpm browser:install`

## Quickstart

```bash
pnpm install
cp .env.example .env            # optional — everything has a default
# add your key to .env to enable the real agent:
#   ANTHROPIC_API_KEY=sk-ant-...

pnpm dev                        # or: pnpm start
# → http://127.0.0.1:8080
```

To enable real browsing:

```bash
pnpm browser:install            # downloads Chromium for Playwright
```

> **Install note:** pnpm may print `ERR_PNPM_IGNORED_BUILDS` for `esbuild`.
> It's harmless (tsx still works). Run `pnpm approve-builds` if you want to
> silence it.

Without an `ANTHROPIC_API_KEY` (or `ant auth login` profile / `ANTHROPIC_AUTH_TOKEN`)
the server runs the **stub brain**: tasks complete immediately with a notice. Add a
credential to get the real agent.

## Configuration

All via environment (see [.env.example](.env.example)). Highlights:

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables the real brain (SDK also reads `ant` profiles). |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model id. |
| `AGENT_MAX_STEPS` | `24` | Hard cap on agent iterations per task. |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | HTTP bind. Keep it on loopback unless you set a token. |
| `API_TOKEN` | — | If set, every `/api/*` call needs `Authorization: Bearer <token>`. |
| `MAX_CONCURRENT_TASKS` | `3` | Tasks running at once; extras queue. |
| `WORKSPACE_QUOTA_BYTES` | `50 MB` | Ceiling for workspace writes (0 = unlimited). |
| `WORKSPACE_DIR` | `./workspace` | The jailed filesystem for file + shell tools. |
| `SHELL_ALLOW` | inspect-only list | Allowlisted command names (no interpreters/network by default). |
| `BROWSER_HEADLESS` | `true` | Set `false` so a human can take control of the window. |
| `BROWSER_ALLOW_PRIVATE_NETWORK` | `false` | When false, private/loopback addresses are blocked (SSRF guard). |

## HTTP API

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness + model + whether Playwright is importable. |
| `GET /api/tasks` | List tasks (summaries). |
| `POST /api/tasks` | Create + start a task. Body: `{ "goal": string, "maxSteps"?: number }`. |
| `GET /api/tasks/:id` | Full task, including the operation log. |
| `POST /api/tasks/:id/pause` | Request a cooperative pause. |
| `POST /api/tasks/:id/resume` | Resume a paused task (keeps context in-process). |
| `POST /api/tasks/:id/cancel` | Request cancellation. |
| `POST /api/tasks/:id/retry` | Reset a terminal task and run it fresh. |
| `GET /api/tasks/:id/events` | **SSE** live stream of a task's state. |
| `GET` / `POST /api/goals` | List / create a page monitor. |
| `POST /api/goals/:id/check` | Run a monitor check right now. |
| `POST /api/goals/:id/pause`·`resume`, `DELETE /api/goals/:id` | Control a monitor. |

```bash
curl -X POST localhost:8080/api/tasks -H 'content-type: application/json' \
  -d '{"goal":"Open example.com and save a summary to notes.md"}'
```

## The agent's tools

`fs_read` · `fs_write` · `fs_list` · `shell_run` · `browser_navigate` ·
`browser_read` · `browser_click` · `browser_type` · `browser_screenshot` ·
`spawn_subagent` · `request_human_takeover` · `task_complete`.

## Architecture

For the full write-up — layers, module reference, the agentic loop, the task
state machine, persistence, and trust boundaries — see
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. The short version:

```
HTTP (api.ts) ──▶ Orchestrator ──▶ AgentLoop ──▶ Brain (Claude | Mock)
                      │                 │
                      │                 ├─▶ ToolRegistry ──▶ Computer
                      ▼                 │                     ├─ WorkspaceFS (jailed)
                 TaskEngine ◀───────────┘                     ├─ Shell (allowlisted)
                      │   (status + operation log)            └─ BrowserSession (SSRF-guarded)
                      ▼
                 TaskStore (atomic JSON)
```

The loop is a **manual agentic loop**: ask the model → run the tool calls →
feed results back, honoring pause/cancel between iterations and logging each
operation. The `Brain` abstraction keeps the loop testable offline and lets you
swap models.

Source map:

```
src/
  config.ts            env → typed Config
  tasks/               types, atomic store, engine (state + audit log, events)
  goals/               types, store, condition evaluator, scheduler/monitor
  computer/            files.ts (jail + quota) · shell.ts (sandbox) · browser.ts (Playwright + SSRF guard)
  agent/               types, brain (Anthropic + mock), tools, loop, subagents
  server/              orchestrator (concurrency), api (auth/CSRF/rate-limit/SSE), web/ (UI)
  index.ts             wiring + boot
test/                  files · shell · engine · loop · goals (offline, no network)
```

## Testing

```bash
pnpm typecheck
pnpm test        # 22 tests; no network or Chromium required
```

## Security

The short version: the shell allowlist and path jail are **defense-in-depth,
not a sandbox**. For anything real, run the whole process inside a container or
VM and put it behind an egress firewall. Full threat model and the review of this
codebase are in **[docs/SECURITY.md](docs/SECURITY.md)**.

## Docker (recommended isolation)

The container is the real sandbox boundary (see `docs/SECURITY.md`).

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up --build
# → http://127.0.0.1:8080   (Chromium + deps baked in)
```

Runs as a non-root user, the workspace as the only app-writable dir, the port
bound to loopback, and `no-new-privileges`. `docker-compose.yml` documents the
stricter read-only-root option.

## Roadmap

- Per-command sandbox providers (E2B / Daytona) behind the `Shell` / `BrowserSession` interfaces, for multi-tenant use — the Dockerfile already isolates the whole process.
- Peer agents running concurrently (subagents run sequentially today).
- Goal alerts out to webhooks / email.

## License

MIT.
