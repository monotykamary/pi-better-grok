import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveGrokCredential, type GrokCredentialContext } from "../src/grok-auth.ts";
import { XAI_PROVIDER_IDS } from "../src/grok-auth.ts";
import {
  getActiveMultiproviderService,
  isMultiproviderService,
  MULTIPROVIDER_SERVICE_EVENT,
  setActiveMultiproviderService,
  type MultiproviderAccountAuth,
  type MultiproviderService,
} from "../src/multiprovider.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalGrokAuthPath = process.env.PI_GROK_AUTH_PATH;

function fakeService(
  resolve: () => Promise<MultiproviderAccountAuth | undefined>,
): MultiproviderService {
  return {
    getActiveAccount: vi.fn(async () => undefined),
    resolveActiveAccountAuth: vi.fn(resolve),
    onActiveAccountChanged: vi.fn(() => () => {}),
  };
}

function credentialContext(): GrokCredentialContext {
  return {
    modelRegistry: {},
    model: { provider: "xai", id: "grok-4.5" },
    sessionManager: { getSessionId: () => "session-1" },
  } as unknown as GrokCredentialContext;
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePiAuth(agentDir: string, token: string): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      xai: { type: "oauth", access: token, expires: Date.now() + 3_600_000 },
    }),
    "utf8",
  );
}

afterEach(() => {
  setActiveMultiproviderService(undefined);
  vi.clearAllMocks();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalGrokAuthPath === undefined) delete process.env.PI_GROK_AUTH_PATH;
  else process.env.PI_GROK_AUTH_PATH = originalGrokAuthPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("detects the pi-multiprovider service payload", () => {
  expect(isMultiproviderService(fakeService(async () => undefined))).toBe(true);
  expect(isMultiproviderService(undefined)).toBe(false);
  expect(isMultiproviderService({ getActiveAccount: () => {} })).toBe(false);
  expect(
    isMultiproviderService({
      getActiveAccount: () => {},
      resolveActiveAccountAuth: () => {},
      onActiveAccountChanged: null,
    }),
  ).toBe(false);
});

test("exposes the shared event name and tracks the active service", () => {
  expect(MULTIPROVIDER_SERVICE_EVENT).toBe("pi-multiprovider:service");
  const service = fakeService(async () => undefined);
  setActiveMultiproviderService(service);
  expect(getActiveMultiproviderService()).toBe(service);
  setActiveMultiproviderService(undefined);
  expect(getActiveMultiproviderService()).toBeUndefined();
});

test("prefers the multiprovider pinned account over local credentials", async () => {
  const service = fakeService(async () => ({
    accessToken: "pooled-token",
    label: "Work",
    source: "Work · xAI OAuth",
  }));
  setActiveMultiproviderService(service);
  const ctx = credentialContext();

  const credential = await resolveGrokCredential(ctx);

  expect(credential).toEqual({ token: "pooled-token", source: "multiprovider" });
  expect(service.resolveActiveAccountAuth).toHaveBeenCalledWith("xai", ctx);
});

test("tries every xai provider id in preference order when no model pins one", async () => {
  const service = fakeService(async () => undefined);
  setActiveMultiproviderService(service);
  const ctx = {
    modelRegistry: {},
    model: undefined,
    sessionManager: { getSessionId: () => "session-1" },
  } as unknown as GrokCredentialContext;

  await resolveGrokCredential(ctx);

  const providerIds = vi.mocked(service.resolveActiveAccountAuth).mock.calls.map((call) => call[0]);
  expect(providerIds).toEqual([...XAI_PROVIDER_IDS]);
});

test("falls back to the pi auth file when no pooled account resolves", async () => {
  const agentDir = createTempDir("pi-better-grok-mp-agent-");
  writePiAuth(agentDir, "stored-access");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_GROK_AUTH_PATH = join(agentDir, "missing-grok-auth.json");
  setActiveMultiproviderService(fakeService(async () => undefined));

  const credential = await resolveGrokCredential(credentialContext());

  expect(credential).toEqual({ token: "stored-access", source: "authFile" });
});

test("falls back when the pooled token is blank or the resolver rejects", async () => {
  const agentDir = createTempDir("pi-better-grok-mp-agent-");
  writePiAuth(agentDir, "stored-access");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_GROK_AUTH_PATH = join(agentDir, "missing-grok-auth.json");

  setActiveMultiproviderService(fakeService(async () => ({ accessToken: "   ", label: "Broken" })));
  expect((await resolveGrokCredential(credentialContext()))?.source).toBe("authFile");

  setActiveMultiproviderService(fakeService(() => Promise.reject(new Error("store locked"))));
  expect((await resolveGrokCredential(credentialContext()))?.source).toBe("authFile");
});

test("uses the local chain when pi-multiprovider is absent", async () => {
  const agentDir = createTempDir("pi-better-grok-mp-agent-");
  writePiAuth(agentDir, "stored-access");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_GROK_AUTH_PATH = join(agentDir, "missing-grok-auth.json");

  const credential = await resolveGrokCredential(credentialContext());

  expect(credential).toEqual({ token: "stored-access", source: "authFile" });
});
