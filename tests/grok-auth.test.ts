import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGrokCliToken, readPiStoredOAuthToken, XAI_PROVIDER_IDS } from "../src/grok-auth.ts";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writePiAuth(auth: unknown): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-better-grok-agent-"));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  return { PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv;
}

function writeGrokCliAuth(auth: unknown): NodeJS.ProcessEnv {
  const file = join(mkdtempSync(join(tmpdir(), "pi-better-grok-cli-")), "auth.json");
  cleanupDirs.push(join(file, ".."));
  writeFileSync(file, JSON.stringify(auth));
  return { PI_GROK_AUTH_PATH: file } as NodeJS.ProcessEnv;
}

const SCOPE_KEY = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const LEGACY_KEY = "https://accounts.x.ai/sign-in";

describe("readPiStoredOAuthToken", () => {
  it("prefers xai, then xai-oauth", () => {
    const env = writePiAuth({
      xai: { type: "oauth", access: "tok-a", refresh: "r", expires: Date.now() + 60_000 },
      "xai-oauth": { type: "oauth", access: "tok-b", expires: Date.now() + 60_000 },
    });
    expect(readPiStoredOAuthToken(env)).toBe("tok-a");
  });

  it("falls back to xai-oauth when xai is absent", () => {
    const env = writePiAuth({
      "xai-oauth": { type: "oauth", access: "tok-b", expires: Date.now() + 60_000 },
    });
    expect(readPiStoredOAuthToken(env)).toBe("tok-b");
  });

  it("rejects expired tokens and falls through", () => {
    const env = writePiAuth({
      xai: { type: "oauth", access: "old", expires: Date.now() - 1_000 },
      "xai-oauth": { type: "oauth", access: "fresh", expires: Date.now() + 60_000 },
    });
    expect(readPiStoredOAuthToken(env)).toBe("fresh");
  });

  it("skips non-oauth credential types", () => {
    const env = writePiAuth({ xai: { type: "api_key", access: "not-oauth" } });
    expect(readPiStoredOAuthToken(env)).toBeNull();
  });

  it("returns null for a missing auth file", () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tmpdir(), "pi-better-grok-nonexistent"),
    } as NodeJS.ProcessEnv;
    expect(readPiStoredOAuthToken(env)).toBeNull();
  });
});

describe("readGrokCliToken", () => {
  it("reads the Grok CLI scope key", () => {
    const env = writeGrokCliAuth({
      [SCOPE_KEY]: { key: "gk-token", expires_at: Date.now() + 60_000 },
    });
    expect(readGrokCliToken(env)).toBe("gk-token");
  });

  it("reads the legacy scope key", () => {
    const env = writeGrokCliAuth({ [LEGACY_KEY]: { key: "legacy-token" } });
    expect(readGrokCliToken(env)).toBe("legacy-token");
  });

  it("reads a top-level access_token", () => {
    const env = writeGrokCliAuth({ access_token: "top-token" });
    expect(readGrokCliToken(env)).toBe("top-token");
  });

  it("rejects expired scope entries", () => {
    const env = writeGrokCliAuth({
      [SCOPE_KEY]: { key: "old", expires_at: Date.now() - 1_000 },
    });
    expect(readGrokCliToken(env)).toBeNull();
  });
});

describe("provider ids", () => {
  it("covers the native and community provider keys", () => {
    expect(XAI_PROVIDER_IDS).toContain("xai");
    expect(XAI_PROVIDER_IDS).toContain("xai-oauth");
  });
});
