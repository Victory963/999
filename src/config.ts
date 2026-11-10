import path from "node:path";

export interface ShellConfig {
  /** Bare executable names the agent is allowed to run. */
  allow: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface BrowserConfig {
  headless: boolean;
  userDataDir: string;
  navigationTimeoutMs: number;
  /** When false, navigation to private/loopback addresses is refused (SSRF guard). */
  allowPrivateNetwork: boolean;
}

export interface Config {
  port: number;
  host: string;
  workspaceDir: string;
  stateDir: string;
  model: string;
  maxSteps: number;
  /** When set, /api/* requires `Authorization: Bearer <token>`. */
  apiToken: string | undefined;
  /** Allowed `Origin` values for mutating API calls (CSRF guard). */
  allowedOrigins: string[];
  /** Max tasks running at once; extra tasks queue as "planned". */
  maxConcurrentTasks: number;
  /** Fixed-window /api request cap per client IP per minute. */
  rateLimitPerMin: number;
  /** Byte ceiling for the workspace (fs_write refuses writes that exceed it). */
  workspaceQuotaBytes: number;
  goalDefaultIntervalSec: number;
  goalMinIntervalSec: number;
  shell: ShellConfig;
  browser: BrowserConfig;
}

/**
 * Default shell allowlist. Deliberately excludes interpreters (node, python,
 * sh, bash, perl…) and network tools (curl, wget): those turn a command-name
 * allowlist into arbitrary code / exfiltration. Keep it to read-only-ish inspect
 * commands and extend it only when the whole process runs inside a container.
 */
const DEFAULT_ALLOW = [
  "ls", "cat", "head", "tail", "wc", "echo", "pwd", "grep", "find", "sort",
  "uniq", "date", "diff", "tr", "cut", "basename", "dirname", "stat", "file",
];

function envStr(env: NodeJS.ProcessEnv, name: string, def: string): string {
  const v = env[name];
  return v === undefined || v === "" ? def : v;
}

function envInt(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === "") return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function envBool(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const workspaceDir = path.resolve(
    envStr(env, "WORKSPACE_DIR", path.join(process.cwd(), "workspace")),
  );
  const stateDir = path.resolve(
    envStr(env, "STATE_DIR", path.join(workspaceDir, ".state")),
  );
  const apiTokenRaw = env.API_TOKEN;
  const port = envInt(env, "PORT", 8080);
  const host = envStr(env, "HOST", "127.0.0.1");
  const defaultOrigins = [`http://${host}:${port}`, `http://localhost:${port}`];

  return {
    port,
    host,
    workspaceDir,
    stateDir,
    model: envStr(env, "ANTHROPIC_MODEL", "claude-opus-5-5"),
    maxSteps: Math.max(1, envInt(env, "AGENT_MAX_STEPS", 24)),
    apiToken: apiTokenRaw && apiTokenRaw !== "" ? apiTokenRaw : undefined,
    allowedOrigins: envStr(env, "ALLOWED_ORIGINS", defaultOrigins.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxConcurrentTasks: Math.max(1, envInt(env, "MAX_CONCURRENT_TASKS", 3)),
    rateLimitPerMin: Math.max(1, envInt(env, "RATE_LIMIT_PER_MIN", 120)),
    workspaceQuotaBytes: Math.max(0, envInt(env, "WORKSPACE_QUOTA_BYTES", 50 * 1024 * 1024)),
    goalDefaultIntervalSec: Math.max(10, envInt(env, "GOAL_DEFAULT_INTERVAL_SEC", 300)),
    goalMinIntervalSec: Math.max(5, envInt(env, "GOAL_MIN_INTERVAL_SEC", 30)),
    shell: {
      allow: envStr(env, "SHELL_ALLOW", DEFAULT_ALLOW.join(","))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      timeoutMs: envInt(env, "SHELL_TIMEOUT_MS", 15_000),
      maxOutputBytes: envInt(env, "SHELL_MAX_OUTPUT_BYTES", 100_000),
    },
    browser: {
      headless: envBool(env, "BROWSER_HEADLESS", true),
      userDataDir: path.resolve(
        envStr(env, "BROWSER_USER_DATA_DIR", path.join(stateDir, "browser-profile")),
      ),
      navigationTimeoutMs: envInt(env, "BROWSER_NAV_TIMEOUT_MS", 30_000),
      allowPrivateNetwork: envBool(env, "BROWSER_ALLOW_PRIVATE_NETWORK", false),
    },
  };
}
