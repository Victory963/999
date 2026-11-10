import { execFile } from "node:child_process";

export class ShellError extends Error {}

export interface ShellResult {
  command: string;
  args: string[];
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface ShellOptions {
  cwd: string;
  allow: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

/** A deliberately minimal PATH so only standard system locations are searched. */
const MINIMAL_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Runs allowlisted commands with no shell interpretation.
 *
 * Hardening:
 *  - allowlist of bare executable names (no path separators), checked per call;
 *  - `shell: false` — arguments are passed as an argv array, so shell
 *    metacharacters in args are inert (no command injection);
 *  - a scrubbed environment: the child sees only PATH/HOME/LANG/TERM, never the
 *    parent process env (which holds ANTHROPIC_API_KEY, API_TOKEN, …), so the
 *    agent cannot read or exfiltrate host secrets through the shell;
 *  - wall-clock timeout and an output-size cap.
 *
 * This is defense-in-depth, NOT a security boundary. Real isolation requires
 * running the whole process in a container/VM — see docs/SECURITY.md.
 */
export class Shell {
  constructor(private readonly opts: ShellOptions) {}

  async run(command: string, args: string[] = []): Promise<ShellResult> {
    if (typeof command !== "string" || command.length === 0) {
      throw new ShellError("command is required");
    }
    if (command.includes("/") || command.includes("\\") || command.includes("\0")) {
      throw new ShellError("command must be a bare executable name (no path separators)");
    }
    if (!this.opts.allow.includes(command)) {
      throw new ShellError(`command not allowlisted: ${command}`);
    }
    if (!Array.isArray(args)) throw new ShellError("args must be an array of strings");
    for (const a of args) {
      if (typeof a !== "string") throw new ShellError("each arg must be a string");
      if (a.includes("\0")) throw new ShellError("arg contains a NUL byte");
    }

    const started = Date.now();
    return new Promise<ShellResult>((resolve) => {
      execFile(
        command,
        args,
        {
          cwd: this.opts.cwd,
          timeout: this.opts.timeoutMs,
          maxBuffer: this.opts.maxOutputBytes,
          shell: false,
          windowsHide: true,
          env: {
            PATH: MINIMAL_PATH,
            HOME: this.opts.cwd,
            LANG: "C.UTF-8",
            TERM: "dumb",
          },
        },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string }) | null;
          const truncated = e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          resolve({
            command,
            args,
            code: e ? (typeof e.code === "number" ? e.code : null) : 0,
            signal: e?.signal ?? null,
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            truncated,
            timedOut: Boolean(e?.killed),
            durationMs: Date.now() - started,
          });
        },
      );
    });
  }
}
