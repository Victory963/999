import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import type { BrowserConfig } from "../config";

export class BrowserError extends Error {}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateV4(mapped[1]);
    return false;
  }
  return true; // not a valid IP literal
}

export interface NavResult {
  url: string;
  status: number | null;
  title: string;
}

/**
 * A persistent Chromium session (via Playwright). The profile lives on disk, so
 * a human can "take control" — sign in once in the visible window — and the
 * agent reuses that session afterwards. Playwright is loaded lazily: the server
 * boots fine without it, and browser tools return a clear error until Chromium
 * is installed (`pnpm browser:install`).
 */
export class BrowserSession {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(
    private readonly opts: BrowserConfig,
    private readonly screenshotDir: string,
  ) {}

  async available(): Promise<boolean> {
    try {
      await import("playwright");
      return true;
    } catch {
      return false;
    }
  }

  async chromiumReady(): Promise<boolean> {
    try {
      const pw = await import("playwright");
      const exe = pw.chromium.executablePath();
      return Boolean(exe) && existsSync(exe);
    } catch {
      return false;
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    let pw: typeof import("playwright");
    try {
      pw = await import("playwright");
    } catch {
      throw new BrowserError(
        "Playwright is not installed. Run `pnpm add playwright` then `pnpm browser:install`.",
      );
    }
    try {
      this.ctx = await pw.chromium.launchPersistentContext(this.opts.userDataDir, {
        headless: this.opts.headless,
        viewport: { width: 1280, height: 800 },
      });
    } catch (err) {
      throw new BrowserError(
        `failed to launch Chromium (did you run \`pnpm browser:install\`?): ${(err as Error).message}`,
      );
    }
    this.ctx.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs);
    this.ctx.setDefaultTimeout(this.opts.navigationTimeoutMs);
    // Network-layer SSRF guard: block every request (top-level, redirect, or
    // subresource) to a private-IP literal or localhost. This catches the
    // classic "public page 302-redirects to 169.254.169.254" metadata attack
    // that a one-shot pre-navigation URL check would miss.
    if (!this.opts.allowPrivateNetwork) {
      await this.ctx.route("**/*", (route) => {
        let host = "";
        try {
          host = new URL(route.request().url()).hostname.replace(/^\[|\]$/g, "");
        } catch {
          /* unparseable → fall through to continue */
        }
        const blocked =
          (net.isIP(host) !== 0 && isPrivateIp(host)) ||
          host === "localhost" ||
          host.endsWith(".localhost");
        if (blocked) void route.abort("addressunreachable");
        else void route.continue();
      });
    }
    return this.ctx;
  }

  private async ensure(): Promise<Page> {
    if (this.page) return this.page;
    const ctx = await this.ensureContext();
    const pages = ctx.pages();
    this.page = pages.length > 0 ? pages[0] : await ctx.newPage();
    return this.page;
  }

  private async assertAllowed(raw: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new BrowserError(`invalid URL: ${raw}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new BrowserError(`blocked URL scheme: ${u.protocol}`);
    }
    if (this.opts.allowPrivateNetwork) return;

    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) {
      if (isPrivateIp(host)) throw new BrowserError(`blocked private address: ${host}`);
      return;
    }
    if (host === "localhost" || host.endsWith(".localhost")) {
      throw new BrowserError("blocked loopback host: localhost");
    }
    let addrs;
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      throw new BrowserError(`could not resolve host: ${host}`);
    }
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        throw new BrowserError(`host ${host} resolves to a private address (${a.address}); blocked`);
      }
    }
  }

  async goto(url: string): Promise<NavResult> {
    await this.assertAllowed(url);
    const page = await this.ensure();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
    return { url: page.url(), status: resp?.status() ?? null, title: await page.title() };
  }

  async readText(maxChars = 8000): Promise<string> {
    const page = await this.ensure();
    const text = await page.innerText("body").catch(() => "");
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
  }

  async currentUrl(): Promise<string> {
    const page = await this.ensure();
    return page.url();
  }

  async click(selector: string): Promise<string> {
    const page = await this.ensure();
    await page.click(selector);
    return `clicked ${selector}; now at ${page.url()}`;
  }

  async type(selector: string, text: string): Promise<string> {
    const page = await this.ensure();
    await page.fill(selector, text);
    return `filled ${selector}`;
  }

  async screenshot(name?: string): Promise<string> {
    const page = await this.ensure();
    await fs.mkdir(this.screenshotDir, { recursive: true });
    const safe = (name ?? `shot-${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, "_");
    const file = path.join(this.screenshotDir, safe.endsWith(".png") ? safe : `${safe}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  }

  /**
   * Fetch a page's text on a throwaway tab (used by goal monitors) without
   * disturbing the agent's main page. Honours the same SSRF guards.
   */
  async fetchText(
    url: string,
    selector?: string,
    maxChars = 8000,
  ): Promise<{ url: string; status: number | null; title: string; text: string }> {
    await this.assertAllowed(url);
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
      const raw = selector
        ? await page.innerText(selector).catch(() => "")
        : await page.innerText("body").catch(() => "");
      const title = await page.title();
      const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…[truncated]` : raw;
      return { url: page.url(), status: resp?.status() ?? null, title, text };
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.page = null;
    }
  }
}
