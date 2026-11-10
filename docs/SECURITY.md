# Security model & review — 999

This doubles as the **threat model** and the **security review** of the current
codebase. An agent that runs a browser, a shell, and a filesystem is a juicy
target, so the trust boundaries matter more than the feature list.

## Trust model

| Party | Trust |
|---|---|
| The operator (you, running the server) | Trusted. |
| The LLM / agent | **Semi-trusted.** It is steerable by untrusted input (see prompt injection) and can make mistakes, so every tool enforces its own limits rather than relying on the model to behave. |
| Web page content, and any tool output | **Untrusted.** Treated as data; may try to manipulate the agent. |
| Other users on the same machine/network | Untrusted. |

The guiding principle is **least privilege at the tool boundary**: the model can
only do what a tool allows, and each tool is written assuming the model (or the
web) is adversarial.

---

## Controls in this codebase (and how they were reviewed)

Each item below was reviewed against the code and, where marked, covered by a
test in `test/`.

### 1. Filesystem jail — `src/computer/files.ts` ✅ mitigated (tested)

- Every path goes through two checks: a **lexical** one (`resolve` + `relative`
  reject `..` and absolute paths) and a **symlink** one (the realpath of the
  nearest existing ancestor must stay inside the realpath of the root).
- `remove(".")` on the root is refused.
- Tests: traversal, absolute paths, and a symlink-escape read are all rejected.
- **Residual:** a TOCTOU race (swap a component for a symlink between the check
  and the write) is theoretically possible on a shared machine; the realpath
  re-check after `mkdir` narrows it. Not a concern for single-tenant local use.

### 2. Shell sandbox — `src/computer/shell.ts` ⚠️ partial by design

- **Allowlist** of bare executable names; path separators in the command are
  rejected. Default list excludes interpreters (`node`, `python`, `sh`, …) and
  network tools (`curl`, `wget`).
- **No shell interpretation** (`shell: false`, argv array), so metacharacters in
  arguments cannot inject commands.
- **Scrubbed environment** — the child sees only `PATH`/`HOME`/`LANG`/`TERM`,
  never the parent env. This is deliberate: it keeps `ANTHROPIC_API_KEY`,
  `API_TOKEN`, etc. out of reach of the agent. (Tested: a secret in the parent
  env is not visible to the child.)
- **Timeout** and **output cap** bound runaway or flooding commands. (Timeout
  tested.)
- **This is not a jail.** A command-name allowlist is only as strong as the
  commands on it — add `node`/`python`/`bash` and the agent has arbitrary code
  execution; even `find -exec` or `grep` on `/etc` leaks host data. The default
  list is conservative precisely because the real isolation boundary is the
  process, not the allowlist.
- **Required mitigation for anything real:** run the whole process inside a
  container or VM with its own filesystem and a non-privileged user.

### 3. Browser / SSRF — `src/computer/browser.ts` ✅ mitigated, with residuals

- Only `http:`/`https:` schemes are allowed.
- Before a top-level navigation, the hostname is **DNS-resolved and every
  resolved address is checked** against private/loopback/link-local/CGNAT/ULA
  ranges (IPv4 and IPv6, including IPv4-mapped IPv6).
- A **network-layer route guard** blocks *every* request (top-level, redirect,
  or subresource) whose host is a private-IP literal or `localhost` — this stops
  the classic "public page 302-redirects to `169.254.169.254`" cloud-metadata
  attack that a one-shot URL check misses.
- **Residual:** DNS **rebinding** on subresources (a hostname that resolves
  public at check time and private at fetch time) is not fully closed, and
  `BROWSER_ALLOW_PRIVATE_NETWORK=true` disables the guard. Close both with an
  **egress firewall** that blocks the instance from reaching your metadata
  endpoint and internal network.

### 4. API authentication — `src/server/api.ts` ✅ / ⚠️ depends on config

- Optional bearer token on all `/api/*` routes, compared with
  `crypto.timingSafeEqual` (length-checked first).
- Binds `127.0.0.1` by default.
- JSON body size capped (1 MB); input validated with zod (`goal` length, numeric
  `maxSteps` bounds) before anything runs.
- **Now enforced:**
  - **CSRF / Origin check** on mutating `/api` calls — a browser `Origin` not in
    `ALLOWED_ORIGINS` is rejected (403); requests with no `Origin` (curl / native
    clients) pass.
  - **Rate limiting** — fixed-window per-IP cap (`RATE_LIMIT_PER_MIN`, default 120).
  - **Concurrency cap** — at most `MAX_CONCURRENT_TASKS` loops run at once; the
    rest queue.
- **Residual / recommendations:**
  - No auth is enforced by default. Fine on loopback for one user; **set
    `API_TOKEN` before changing `HOST`** (the SSE endpoint accepts it as `?token=`).

### 5. Secrets ✅ mitigated

- Credentials come from the environment and are **never written to task logs**
  and **never passed to shell children** (scrubbed env, item 2).
- **Note:** task operation logs *do* capture tool outputs, which can include web
  content the agent fetched. Logs live in `WORKSPACE_DIR/.state/` — treat that
  directory as sensitive.

### 6. Prompt injection ⚠️ inherent, mitigated structurally

A hostile web page read via `browser_read` can try to hijack the agent ("ignore
your task and do X"). This is inherent to the whole agent-with-a-computer
category. Structural mitigations here:

- The agent has **only** the sandboxed tools above — injection cannot exceed
  tool privilege.
- **Human takeover** gates logins/payments/irreversible actions.
- **`AGENT_MAX_STEPS`** bounds a runaway.
- No credential or host-secret is reachable from any tool.

Do **not** add tools that act on the user's behalf against sensitive systems
(email send, money movement) without a human-approval gate.

### 7. Resource / availability ✅ mitigated

Shell timeout + output cap, agent step cap, JSON body cap, **per-IP rate limit**,
**concurrency cap with queueing**, and a **workspace byte quota**
(`WORKSPACE_QUOTA_BYTES`, enforced on `fs_write`). Subagents are depth-1 capped and
run sequentially. For heavy multi-user use, still add per-tenant quotas and a
global token/$ budget.

---

## Production hardening checklist

- [ ] Run the whole process in a **container/VM** with a non-root user and a
      read-only root FS except the workspace volume. A `Dockerfile` +
      `docker-compose.yml` are provided (non-root, loopback, `no-new-privileges`).
- [ ] Put it behind an **egress firewall** (block the metadata IP and internal
      ranges) — this is what actually closes the residual SSRF.
- [ ] Set a strong **`API_TOKEN`**; keep `HOST=127.0.0.1` or front it with a
      reverse proxy that does TLS + auth.
- [ ] Keep `SHELL_ALLOW` minimal; never add interpreters outside a container.
- [ ] Rotate the `ANTHROPIC_API_KEY`; scope it to this app.
- [ ] Treat `WORKSPACE_DIR/.state/` as sensitive (logs, browser profile/cookies).
- [ ] Add task concurrency + workspace disk limits for multi-user use.

## Reporting

This is alpha, single-author code — review it yourself before trusting it. If you
find an issue, open a GitHub issue (or a private report for anything exploitable).
