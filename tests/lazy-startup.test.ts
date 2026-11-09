import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Records which optional graphs a test has pulled in. The doMock factories are
// registered afresh before each test and run when their module is first
// imported, so an entry here means the module was loaded by that test.
const loaded = new Set<string>();

function trackModuleLoads(): void {
  vi.doMock("../src/settings-ui.ts", async (importOriginal) => {
    loaded.add("settings-ui");
    return importOriginal();
  });
  vi.doMock("../src/reset-command.ts", async (importOriginal) => {
    loaded.add("reset-command");
    return importOriginal();
  });
  vi.doMock("../src/resets.ts", async (importOriginal) => {
    loaded.add("resets");
    return importOriginal();
  });
  vi.doMock("@earendil-works/pi-coding-agent", () => {
    loaded.add("pi-coding-agent");
    const identity = (text: string) => text;
    return {
      getSettingsListTheme: () => ({
        label: identity,
        value: identity,
        description: identity,
        cursor: "> ",
        hint: identity,
      }),
    };
  });
}

const USAGE_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
const REMAINING_RESETS_URL_PREFIX = "https://grok.com/";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalGrokAuthPath = process.env.PI_GROK_AUTH_PATH;

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function stubFetch() {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 503 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fetchedUrls(fetchMock: ReturnType<typeof stubFetch>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

async function createHarness(options: { grokModel: boolean; tui: boolean }) {
  const cwd = createTempDir("pi-better-grok-lazy-project-");
  const agentDir = createTempDir("pi-better-grok-lazy-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_GROK_AUTH_PATH = join(agentDir, "missing-grok-auth.json");
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      xai: { type: "oauth", access: "lazy-access", expires: Date.now() + 3_600_000 },
    }),
    "utf8",
  );
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-grok.json"),
    JSON.stringify({
      persistState: false,
      usage: { enabled: true, refreshIntervalMs: 60000 },
      resets: { cookies: "cf_clearance=lazy", userAgent: "LazyBrowser/1.0" },
    }),
    "utf8",
  );

  const { default: betterGrok } = await import("../index.ts");
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, { handler: CommandHandler }>();
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => {
      commands.set(name, command);
    }),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
    setModel: vi.fn(async () => true),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: options.tui,
    mode: options.tui ? "tui" : "print",
    model: options.grokModel
      ? { provider: "xai", id: "grok-4.5" }
      : { provider: "anthropic", id: "claude-test" },
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn(async () => false),
      custom: vi.fn(async () => undefined),
      setFooter: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
      getLeafId: vi.fn(() => undefined),
    },
    modelRegistry: { isUsingOAuth: vi.fn(() => options.grokModel) },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  } as unknown as ExtensionContext;

  betterGrok(pi);
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { ctx, commands, emit };
}

beforeEach(() => {
  loaded.clear();
  vi.resetModules();
  trackModuleLoads();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalGrokAuthPath === undefined) delete process.env.PI_GROK_AUTH_PATH;
  else process.env.PI_GROK_AUTH_PATH = originalGrokAuthPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("startup keeps optional graphs unloaded", () => {
  test("importing and registering the extension loads no command-time module", async () => {
    stubFetch();
    const { commands } = await createHarness({ grokModel: false, tui: true });

    expect([...commands.keys()].sort()).toEqual([
      "grok-fast",
      "grok-resets",
      "grok-settings",
      "grok-usage",
    ]);
    expect([...loaded]).toEqual([]);
  });

  test("session start on a non-Grok model leaves resets and command UIs unloaded", async () => {
    const fetchMock = stubFetch();
    const harness = await createHarness({ grokModel: false, tui: true });

    await harness.emit("session_start");
    await new Promise((resolve) => setImmediate(resolve));

    expect([...loaded]).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    // session_start ran to completion: footer totals were rebuilt from the session.
    expect(harness.ctx.sessionManager.getEntries).toHaveBeenCalled();
    await harness.emit("session_shutdown");
  });

  test("session start on a subscription model still runs the usage and banked-reset refresh", async () => {
    const fetchMock = stubFetch();
    const harness = await createHarness({ grokModel: true, tui: true });

    await harness.emit("session_start");
    await vi.waitFor(() => {
      const urls = fetchedUrls(fetchMock);
      expect(urls.some((url) => url.startsWith(USAGE_USER_URL))).toBe(true);
      expect(urls.some((url) => url.startsWith(REMAINING_RESETS_URL_PREFIX))).toBe(true);
    });

    // The reset prefetch is what loads the RPC codec; the redeem UI and the
    // settings picker stay unloaded until their commands run.
    expect(loaded.has("resets")).toBe(true);
    expect(loaded.has("reset-command")).toBe(false);
    expect(loaded.has("settings-ui")).toBe(false);
    expect(loaded.has("pi-coding-agent")).toBe(false);
    // The config refresh recorded the clearance profile before resets.ts
    // loaded; the lazily loaded RPC still sends it.
    const resetCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).startsWith(REMAINING_RESETS_URL_PREFIX),
    );
    const headers = resetCall?.[1]?.headers as Record<string, string>;
    expect(headers.Cookie).toBe("cf_clearance=lazy");
    expect(headers["User-Agent"]).toBe("LazyBrowser/1.0");
    await harness.emit("session_shutdown");
  });
});

describe("command-time modules load on first use", () => {
  test("/grok-settings loads the picker and renders the settings list", async () => {
    stubFetch();
    const { ctx, commands } = await createHarness({ grokModel: false, tui: true });
    let rendered: string[] = [];
    vi.mocked(ctx.ui.custom).mockImplementation(async (factory: unknown) => {
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };
      const component = (
        factory as (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: unknown) => void,
        ) => { render(width: number): string[] }
      )({ requestRender: vi.fn() }, theme, {}, () => {});
      rendered = component.render(80);
      return undefined;
    });

    await commands.get("grok-settings")?.handler("", ctx);

    expect(loaded.has("settings-ui")).toBe(true);
    expect(loaded.has("pi-coding-agent")).toBe(true);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    const text = rendered.join("\n");
    expect(text).toContain("Better Grok Settings");
    expect(text).toContain("Footer mode");
    expect(text).toContain("Usage display");
  });

  test("/grok-resets loads the redeem flow on first use", async () => {
    stubFetch();
    const { ctx, commands } = await createHarness({ grokModel: true, tui: true });

    await commands.get("grok-resets")?.handler("", ctx);

    expect(loaded.has("reset-command")).toBe(true);
    expect(loaded.has("resets")).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Banked reset lookup failed"),
      "error",
    );
  });

  test("non-TUI sessions refuse both commands without loading them", async () => {
    stubFetch();
    const { ctx, commands } = await createHarness({ grokModel: true, tui: false });

    await commands.get("grok-settings")?.handler("", ctx);
    await commands.get("grok-resets")?.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Better Grok settings require interactive TUI mode.",
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "/grok-resets requires an interactive TUI session.",
      "warning",
    );
    expect(loaded.has("settings-ui")).toBe(false);
    expect(loaded.has("reset-command")).toBe(false);
  });
});
