import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildGrokResetConfirmation,
  decodeGrpcWebResponse,
  decodeRedeemResetTokenId,
  decodeRemainingResetTokens,
  EMPTY_RESET_CREDITS,
  encodeGrpcWebRequest,
  encodeRedeemResetRequest,
  fetchGrokResetCredits,
  formatGrokResetChoice,
  formatGrokResetOutcome,
  GROK_REDEEM_RESET_URL,
  GROK_REMAINING_RESETS_URL,
  mapGrokRedeemStatus,
  redeemGrokReset,
  requestGrokResetCredits,
  redeemGrokResetForSession,
  ResetError,
  selectGrokResetToken,
  summarizeResetTokens,
  type GrokResetToken,
} from "../src/resets.ts";
import { ResetController } from "../src/reset-controller.ts";
import { formatPercent } from "../src/usage.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalGrokAuthPath = process.env.PI_GROK_AUTH_PATH;

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeGrokAuth(agentDir: string, token = "resets-access"): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      xai: { type: "oauth", access: token, expires: Date.now() + 3_600_000 },
    }),
    "utf8",
  );
}

function isolateAuth(): string {
  const agentDir = createTempDir("pi-better-grok-resets-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_GROK_AUTH_PATH = join(agentDir, "missing-grok-auth.json");
  return agentDir;
}

// Minimal protobuf encoder for building wire-shape test fixtures.
function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let n = value;
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return bytes;
}

function encodeBytes(field: number, data: number[]): number[] {
  return [...encodeVarint((field << 3) | 2), ...encodeVarint(data.length), ...data];
}

function encodeVarintField(field: number, value: number): number[] {
  return [...encodeVarint((field << 3) | 0), ...encodeVarint(value)];
}

// Parses a one-frame gRPC-Web request body (no trailer, no status).
function requestPayload(body: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(body);
  return bytes.subarray(5);
}

function encodeString(field: number, value: string): number[] {
  return encodeBytes(field, [...new TextEncoder().encode(value)]);
}

function grpcFrame(flags: number, payload: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(5);
  header[0] = flags;
  header[1] = (payload.byteLength >>> 24) & 0xff;
  header[2] = (payload.byteLength >>> 16) & 0xff;
  header[3] = (payload.byteLength >>> 8) & 0xff;
  header[4] = payload.byteLength & 0xff;
  return Uint8Array.from([...header, ...payload]);
}

function tokenPayload(token: {
  tokenId: string;
  grantedAtMs?: number | null;
  expiresAtMs?: number | null;
}): number[] {
  const fields: number[] = [...encodeString(10, token.tokenId)];
  if (token.grantedAtMs != null) {
    fields.push(...encodeBytes(20, encodeVarintField(1, Math.floor(token.grantedAtMs / 1000))));
  }
  if (token.expiresAtMs != null) {
    fields.push(...encodeBytes(30, encodeVarintField(1, Math.floor(token.expiresAtMs / 1000))));
  }
  return encodeBytes(10, fields);
}

function grpcOkResponse(payload: number[], status = "0"): Uint8Array<ArrayBuffer> {
  const trailer = new TextEncoder().encode(`grpc-status:${status}\r\n`);
  return Uint8Array.from([...grpcFrame(0, Uint8Array.from(payload)), ...grpcFrame(0x80, trailer)]);
}

function grpcErrorResponse(status: string, message = ""): Uint8Array<ArrayBuffer> {
  const trailer = new TextEncoder().encode(
    `grpc-status:${status}\r\ngrpc-message:${encodeURIComponent(message)}\r\n`,
  );
  return grpcFrame(0x80, trailer);
}

function stubResetsFetch(options?: {
  tokens?: { tokenId: string; grantedAtMs?: number | null; expiresAtMs?: number | null }[];
  redeemStatus?: string;
  redeemMessage?: string;
  listStatus?: string;
}): ReturnType<typeof vi.fn> {
  const tokens = options?.tokens ?? [
    {
      tokenId: "restok_test1",
      grantedAtMs: 1_781_234_567_000,
      expiresAtMs: Date.now() + 86_400_000,
    },
  ];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url === GROK_REMAINING_RESETS_URL) {
      if (options?.listStatus && options.listStatus !== "0") {
        return new Response(grpcErrorResponse(options.listStatus, "no inventory"), { status: 200 });
      }
      return new Response(grpcOkResponse(tokens.flatMap((token) => tokenPayload(token))), {
        status: 200,
      });
    }
    if (url === GROK_REDEEM_RESET_URL) {
      const status = options?.redeemStatus ?? "0";
      if (status === "0") return new Response(grpcOkResponse([]), { status: 200 });
      return new Response(grpcErrorResponse(status, options?.redeemMessage ?? ""), { status: 200 });
    }
    if (url.includes("cli-chat-proxy.grok.com/v1/user")) {
      return new Response(JSON.stringify({ userId: "user_resets" }), { status: 200 });
    }
    if (url.includes("cli-chat-proxy.grok.com/v1/billing")) {
      return new Response(JSON.stringify({ config: { creditUsagePercent: 12 } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function credential(): { token: string; source: "authFile" } {
  return { token: "resets-access", source: "authFile" };
}

function redeemCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return (fetchMock.mock.calls as unknown[][]).filter(
    (call) => String(call[0]) === GROK_REDEEM_RESET_URL,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalGrokAuthPath === undefined) delete process.env.PI_GROK_AUTH_PATH;
  else process.env.PI_GROK_AUTH_PATH = originalGrokAuthPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gRPC-Web codec", () => {
  test("round-trips the redeem request token_id on field 10", () => {
    const payload = encodeRedeemResetRequest("restok_abc123");
    expect(decodeRedeemResetTokenId(payload)).toBe("restok_abc123");
    const frames = encodeGrpcWebRequest(payload);
    expect(frames[0]).toBe(0);
    const len = payload.byteLength;
    expect(Array.from(frames.slice(1, 5))).toEqual([
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
    ]);
    expect(Array.from(frames.subarray(5))).toEqual(Array.from(payload));
    expect(decodeRedeemResetTokenId(frames.subarray(5))).toBe("restok_abc123");
  });

  test("decodes remaining-reset tokens with granted and expiry timestamps", () => {
    const payload = Uint8Array.from(
      tokenPayload({
        tokenId: "restok_soon",
        expiresAtMs: 1_781_760_000_000,
        grantedAtMs: 1_781_234_567_000,
      }),
    );
    const tokens = decodeRemainingResetTokens(payload);
    expect(tokens).toEqual([
      { tokenId: "restok_soon", grantedAtMs: 1_781_234_567_000, expiresAtMs: 1_781_760_000_000 },
    ]);
  });

  test("prefers trailer grpc-status over response headers", () => {
    const response = grpcErrorResponse("16", "stale token");
    const parsed = decodeGrpcWebResponse(response, "0", "header message");
    expect(parsed.grpcStatus).toBe("16");
    expect(parsed.grpcMessage).toBe("stale token");
    expect(parsed.payload.byteLength).toBe(0);
  });

  test("falls back to header grpc-status when no trailer frame is present", () => {
    const parsed = decodeGrpcWebResponse(
      grpcFrame(0, Uint8Array.from(tokenPayload({ tokenId: "restok_x" }))),
      "0",
      null,
    );
    expect(parsed.grpcStatus).toBe("0");
    expect(parsed.payload.byteLength).toBeGreaterThan(0);
  });
});

describe("summarizeResetTokens", () => {
  test("keeps bounded printable token ids and derives the next expiry", () => {
    const summary = summarizeResetTokens([
      { tokenId: "restok_late", grantedAtMs: null, expiresAtMs: 3_000 },
      { tokenId: "restok_soon", grantedAtMs: null, expiresAtMs: 1_000 },
      { tokenId: "", grantedAtMs: null, expiresAtMs: 500 },
      { tokenId: "x".repeat(129), grantedAtMs: null, expiresAtMs: 700 },
      { tokenId: "bad\u0000id", grantedAtMs: null, expiresAtMs: 600 },
    ]);
    expect(summary.availableCount).toBe(2);
    expect(summary.nextExpiresAtMs).toBe(1_000);
    expect(summary.tokens.map((token) => token.tokenId)).toEqual(["restok_late", "restok_soon"]);
  });

  test("returns empty credits for malformed input", () => {
    expect(summarizeResetTokens([])).toEqual(EMPTY_RESET_CREDITS);
  });
});

describe("selectGrokResetToken", () => {
  test("prefers the soonest-expiring token", () => {
    const token = (id: string, expiresAtMs: number | null): GrokResetToken => ({
      tokenId: id,
      grantedAtMs: null,
      expiresAtMs,
    });
    expect(
      selectGrokResetToken([token("late", 3_000), token("soon", 1_000), token("none", null)])
        ?.tokenId,
    ).toBe("soon");
    expect(selectGrokResetToken([token("none", null)])?.tokenId).toBe("none");
    expect(selectGrokResetToken([])).toBeUndefined();
  });
});

describe("mapGrokRedeemStatus", () => {
  test("maps observed grpc-status codes to outcomes", () => {
    expect(mapGrokRedeemStatus("0", null)).toEqual({ code: "reset" });
    expect(mapGrokRedeemStatus("9", "token already redeemed")).toEqual({
      code: "already_redeemed",
    });
    expect(mapGrokRedeemStatus("9", "weekly limit not exhausted")).toEqual({ code: "no_credit" });
    expect(mapGrokRedeemStatus("3", "invalid token_id")).toEqual({ code: "no_credit" });
  });

  test("throws on unexpected statuses", () => {
    expect(() => mapGrokRedeemStatus("13", "internal")).toThrow(ResetError);
    expect(() => mapGrokRedeemStatus("2", null)).toThrow(/grpc-status 2/);
  });
});

describe("fetchGrokResetCredits", () => {
  test("posts gRPC-Web framing with CLI auth headers to the inventory endpoint", async () => {
    const fetchMock = stubResetsFetch();

    const credits = await fetchGrokResetCredits(credential());

    expect(credits.availableCount).toBe(1);
    expect(credits.tokens[0]?.tokenId).toBe("restok_test1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GROK_REMAINING_RESETS_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer resets-access",
      "X-XAI-Token-Auth": "xai-grok-cli",
      "Content-Type": "application/grpc-web+proto",
      "x-grpc-web": "1",
    });
    const body = new Uint8Array(init.body as ArrayBuffer);
    expect(Array.from(body)).toEqual([0, 0, 0, 0, 0]);
  });

  test("maps grpc-status 16 to an auth error and unknown statuses to zero credits", async () => {
    stubResetsFetch({ listStatus: "16" });
    await expect(fetchGrokResetCredits(credential())).rejects.toThrow(ResetError);
    await expect(fetchGrokResetCredits(credential())).rejects.toThrow(/credential/);

    const fetchMock = stubResetsFetch({ listStatus: "7" });
    await expect(fetchGrokResetCredits(credential())).resolves.toEqual(EMPTY_RESET_CREDITS);
    expect(fetchMock).toHaveBeenCalled();
  });

  test("surfaces HTTP auth and server failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );
    await expect(fetchGrokResetCredits(credential())).rejects.toThrow(/unauthorized/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await expect(fetchGrokResetCredits(credential())).rejects.toThrow(/HTTP 500/);
  });

  test("refuses to hit the network without a token", async () => {
    const fetchMock = stubResetsFetch();
    await expect(fetchGrokResetCredits({ token: "", source: "authFile" })).rejects.toThrow(
      /credentials are required/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("redeemGrokReset", () => {
  test("redeems the given token id exactly once", async () => {
    const fetchMock = stubResetsFetch({ redeemStatus: "0" });

    const result = await redeemGrokReset(credential(), "restok_test1");

    expect(result).toEqual({ code: "reset" });
    const posts = redeemCalls(fetchMock);
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0] as unknown as [string, RequestInit];
    expect(url).toBe(GROK_REDEEM_RESET_URL);
    expect(decodeRedeemResetTokenId(requestPayload(init.body as ArrayBuffer))).toBe("restok_test1");
  });

  test("lists first and picks the soonest-expiring token when none is given", async () => {
    const fetchMock = stubResetsFetch({
      tokens: [
        { tokenId: "restok_late", expiresAtMs: 9_000 },
        { tokenId: "restok_soon", expiresAtMs: 2_000 },
      ],
    });

    const result = await redeemGrokReset(credential(), undefined);

    expect(result).toEqual({ code: "reset" });
    const posts = redeemCalls(fetchMock);
    const [, init] = posts[0] as unknown as [string, RequestInit];
    expect(decodeRedeemResetTokenId(requestPayload(init.body as ArrayBuffer))).toBe("restok_soon");
  });

  test("returns no_credit without a redeem post when the inventory is empty", async () => {
    const fetchMock = stubResetsFetch({ tokens: [] });

    const result = await redeemGrokReset(credential(), undefined);

    expect(result).toEqual({ code: "no_credit" });
    expect(redeemCalls(fetchMock)).toHaveLength(0);
  });

  test("maps already-redeemed and no-credit redeem responses", async () => {
    stubResetsFetch({ redeemStatus: "9", redeemMessage: "token already redeemed" });
    await expect(redeemGrokReset(credential(), "restok_test1")).resolves.toEqual({
      code: "already_redeemed",
    });

    stubResetsFetch({ redeemStatus: "3", redeemMessage: "bad token_id" });
    await expect(redeemGrokReset(credential(), "restok_test1")).resolves.toEqual({
      code: "no_credit",
    });

    stubResetsFetch({ redeemStatus: "13", redeemMessage: "internal" });
    await expect(redeemGrokReset(credential(), "restok_test1")).rejects.toThrow(
      /Grok reset failed/,
    );
  });
});

describe("context wrappers", () => {
  test("requestGrokResetCredits returns undefined without credentials", async () => {
    isolateAuth();
    const fetchMock = stubResetsFetch();

    await expect(
      requestGrokResetCredits({
        model: undefined,
        modelRegistry: undefined,
        sessionManager: undefined,
      } as never),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("redeemGrokResetForSession throws without credentials", async () => {
    isolateAuth();
    const fetchMock = stubResetsFetch();

    await expect(
      redeemGrokResetForSession(
        { model: undefined, modelRegistry: undefined, sessionManager: undefined } as never,
        "restok_test1",
      ),
    ).rejects.toThrow(/authentication is unavailable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("formatting", () => {
  test("formatGrokResetChoice masks the token id and shows expiry", () => {
    const line = formatGrokResetChoice(
      {
        tokenId: "restok_vpYDqo",
        grantedAtMs: null,
        expiresAtMs: Date.parse("2026-07-17T00:00:00Z"),
      },
      0,
    );
    expect(line).toContain("1. SuperGrok rate-limit reset");
    expect(line).toContain("rest");
    expect(line).not.toContain("restok_vpYDqo");
    expect(line).toContain("expires");
  });

  test("formatGrokResetOutcome maps codes to notifications", () => {
    expect(formatGrokResetOutcome({ code: "reset" })).toEqual({
      message: "Banked reset redeemed — your SuperGrok usage limit was restored.",
      level: "info",
    });
    expect(formatGrokResetOutcome({ code: "no_credit" }).level).toBe("warning");
    expect(formatGrokResetOutcome({ code: "already_redeemed" }).level).toBe("warning");
  });

  test("buildGrokResetConfirmation shows availability, usage, and the warning", () => {
    const confirmation = buildGrokResetConfirmation({
      token: {
        tokenId: "restok_vpYDqo",
        grantedAtMs: 1_781_234_567_000,
        expiresAtMs: 1_781_760_000_000,
      },
      availableCount: 2,
      snapshot: { creditUsagePercent: 87.4 },
    });
    expect(confirmation.title).toBe("Redeem banked Grok reset?");
    expect(confirmation.message).toContain("SuperGrok rate-limit reset");
    expect(confirmation.message).toContain("Available: 2");
    expect(confirmation.message).toContain(`weekly ${formatPercent(87.4)} used`);
    expect(confirmation.message).toContain("cannot be undone");
  });

  test("buildGrokResetConfirmation falls back to auto-selection copy", () => {
    const confirmation = buildGrokResetConfirmation({ availableCount: 1 });
    expect(confirmation.message).toContain("Token: auto-selected");
    expect(confirmation.message).toContain("Expires: unknown");
    expect(confirmation.message).toContain("Available: 1");
  });
});

describe("ResetController caching", () => {
  function controllerCtx(): ExtensionContext {
    return {
      modelRegistry: undefined,
      model: undefined,
      sessionManager: undefined,
    } as unknown as ExtensionContext;
  }

  test("serves repeated refreshes from the cache within the TTL", async () => {
    writeGrokAuth(isolateAuth());
    const fetchMock = stubResetsFetch();
    const controller = new ResetController();
    const ctx = controllerCtx();

    await controller.refresh(ctx);

    expect(controller.snapshot?.credits.availableCount).toBe(1);
    expect(controller.isFresh()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await controller.refresh(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await controller.refresh(ctx, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("keeps the previous cache and records the error when a refresh fails", async () => {
    writeGrokAuth(isolateAuth());
    const fetchMock = stubResetsFetch();
    const controller = new ResetController();
    const ctx = controllerCtx();
    await controller.refresh(ctx);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await controller.refresh(ctx, { force: true });

    expect(controller.lastError).toContain("failed");
    expect(controller.snapshot?.credits.availableCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not fetch without credentials and records the error", async () => {
    isolateAuth();
    const fetchMock = stubResetsFetch();
    const controller = new ResetController();

    await controller.refresh(controllerCtx());

    expect(controller.snapshot).toBeUndefined();
    expect(controller.lastError).toContain("credentials unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

async function settleAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function createResetsHarness(): Promise<{
  ctx: ExtensionContext;
  commands: Map<string, { handler: CommandHandler }>;
  handlers: Map<string, EventHandler[]>;
}> {
  const cwd = createTempDir("pi-better-grok-resets-project-");
  const agentDir = isolateAuth();
  writeGrokAuth(agentDir);
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-grok.json"),
    JSON.stringify({ persistState: false, usage: { enabled: true, refreshIntervalMs: 60000 } }),
    "utf8",
  );
  vi.resetModules();
  const { default: betterGrok } = await import("../index.ts");

  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, { handler: CommandHandler }>();
  const pi = {
    on(event: string, handler: EventHandler) {
      const currentHandlers = handlers.get(event) ?? [];
      currentHandlers.push(handler);
      handlers.set(event, currentHandlers);
    },
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => {
      commands.set(name, command);
    }),
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    model: { provider: "xai", id: "grok-4.5" },
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn(),
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
    modelRegistry: {
      isUsingOAuth: vi.fn(() => true),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  } as unknown as ExtensionContext;

  betterGrok(pi);
  return { ctx, commands, handlers };
}

async function emit(
  harness: { handlers: Map<string, EventHandler[]>; ctx: ExtensionContext },
  event: string,
  payload: unknown = {},
): Promise<void> {
  const handlers = harness.handlers.get(event) ?? [];
  for (const handler of handlers) {
    await handler(payload, harness.ctx);
  }
}

describe("/grok-resets command", () => {
  test("offers no confirmation when no banked tokens are available", async () => {
    const fetchMock = stubResetsFetch({ tokens: [] });
    const { ctx, commands } = await createResetsHarness();

    await commands.get("grok-resets")?.handler("", ctx);
    await settleAsyncWork();

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No banked Grok resets are available for this account.",
      "info",
    );
    expect(redeemCalls(fetchMock)).toHaveLength(0);
  });

  test("requires explicit confirmation and sends nothing when declined", async () => {
    const fetchMock = stubResetsFetch();
    const { ctx, commands } = await createResetsHarness();
    vi.mocked(ctx.ui.confirm).mockResolvedValue(false);

    await commands.get("grok-resets")?.handler("", ctx);
    await settleAsyncWork();

    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    const [title, message] = vi.mocked(ctx.ui.confirm).mock.calls[0] as unknown as [string, string];
    expect(title).toBe("Redeem banked Grok reset?");
    expect(message).toContain("SuperGrok rate-limit reset");
    expect(message).toContain("Available: 1");
    expect(message).toContain("cannot be undone");
    expect(redeemCalls(fetchMock)).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Banked reset redemption cancelled.", "info");
  });

  test("redeems exactly one token after confirmation", async () => {
    const fetchMock = stubResetsFetch({ redeemStatus: "0" });
    const { ctx, commands } = await createResetsHarness();
    vi.mocked(ctx.ui.confirm).mockResolvedValue(true);

    await commands.get("grok-resets")?.handler("", ctx);
    await vi.waitFor(() => expect(redeemCalls(fetchMock)).toHaveLength(1));

    expect(ctx.ui.select).not.toHaveBeenCalled();
    const posts = redeemCalls(fetchMock);
    expect(posts).toHaveLength(1);
    const [, init] = posts[0] as unknown as [string, RequestInit];
    expect(decodeRedeemResetTokenId(requestPayload(init.body as ArrayBuffer))).toBe("restok_test1");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Banked reset redeemed — your SuperGrok usage limit was restored.",
      "info",
    );
  });

  test("asks which token to redeem when several are available", async () => {
    const fetchMock = stubResetsFetch({
      tokens: [
        {
          tokenId: "restok_soon",
          grantedAtMs: 1_781_234_567_000,
          expiresAtMs: Date.parse("2026-07-01T00:00:00Z"),
        },
        {
          tokenId: "restok_later",
          grantedAtMs: 1_781_234_567_000,
          expiresAtMs: Date.parse("2026-09-01T00:00:00Z"),
        },
      ],
      redeemStatus: "0",
    });
    const { ctx, commands } = await createResetsHarness();
    vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
    vi.mocked(ctx.ui.select).mockImplementation(async (_title, options) => options[1]);

    await commands.get("grok-resets")?.handler("", ctx);
    await vi.waitFor(() => expect(redeemCalls(fetchMock)).toHaveLength(1));

    const [title, options] = vi.mocked(ctx.ui.select).mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(title).toBe("Redeem which banked reset?");
    expect(options).toHaveLength(2);
    expect(options[0]).toContain("rest...soon");
    expect(options[0]).toContain("expires");
    expect(options[0]).not.toContain("unknown");
    const posts = redeemCalls(fetchMock);
    const [, init] = posts[0] as unknown as [string, RequestInit];
    expect(decodeRedeemResetTokenId(requestPayload(init.body as ArrayBuffer))).toBe("restok_later");
    const [, confirmMessage] = vi.mocked(ctx.ui.confirm).mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(confirmMessage).toContain("rest");
  });

  test("opens from the warmed session cache without new requests", async () => {
    const fetchMock = stubResetsFetch();
    const harness = await createResetsHarness();
    vi.mocked(harness.ctx.ui.confirm).mockResolvedValue(false);
    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await settleAsyncWork();

    fetchMock.mockClear();
    await harness.commands.get("grok-resets")?.handler("", harness.ctx);
    await settleAsyncWork();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(redeemCalls(fetchMock)).toHaveLength(0);
    await emit(harness, "session_shutdown");
  });
});
