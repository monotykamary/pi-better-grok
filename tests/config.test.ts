import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySettingToRawConfig,
  configPaths,
  DEFAULT_CONFIG,
  normalizeModelKeys,
  parseModelKey,
  readRawConfig,
  resolveConfig,
  writeConfig,
} from "../src/config.ts";

const cleanupDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-better-grok-config-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveConfig", () => {
  it("returns defaults when no config files exist", () => {
    const home = tempDir();
    const cwd = tempDir();
    const config = resolveConfig(cwd, home, {});
    expect(config.persistState).toBe(true);
    expect(config.active).toBe(false);
    expect(config.desiredActive).toBe(false);
    expect(config.footer.mode).toBe("replace");
    expect(config.usage.enabled).toBe(true);
    expect(config.usage.refreshIntervalMs).toBe(60_000);
    expect(config.usage.showOnlyOnSubscriptionModels).toBe(true);
    expect(config.usage.showResetTimes).toBe(true);
    expect(config.fast.effort).toBe("low");
    expect(config.supportedModels.length).toBeGreaterThan(0);
    expect(config.configPath).toBe(config.globalConfigPath);
  });

  it("merges global then project overrides", () => {
    const home = tempDir();
    const cwd = tempDir();
    const paths = configPaths(cwd, home, {});
    mkdirSync(join(paths.global, ".."), { recursive: true });
    mkdirSync(join(paths.project, ".."), { recursive: true });
    writeConfig(paths.global, { footer: { mode: "status" }, usage: { enabled: true } });
    writeConfig(paths.project, { usage: { enabled: false }, customField: 7 });
    const config = resolveConfig(cwd, home, {});
    expect(config.footer.mode).toBe("status");
    expect(config.usage.enabled).toBe(false);
    expect(config.configPath).toBe(paths.project);
  });
});

describe("parseModelKey", () => {
  it("parses provider/id keys and rejects malformed ones", () => {
    expect(parseModelKey("xai/grok-4.5")).toEqual({ provider: "xai", id: "grok-4.5" });
    expect(parseModelKey("/grok-4.5")).toBeUndefined();
    expect(parseModelKey("xai/")).toBeUndefined();
    expect(parseModelKey("no-separator")).toBeUndefined();
  });

  it("normalizes model keys", () => {
    expect(normalizeModelKeys([{ provider: "xai", id: "grok-4.6" }])).toEqual(["xai/grok-4.6"]);
  });
});

describe("applySettingToRawConfig", () => {
  it("writes section keys and preserves unknown fields", () => {
    const current = { unknown: { a: 1 }, footer: { mode: "off", custom: 2 } };
    const next = applySettingToRawConfig(current, "footer.mode", "replace");
    expect((next.footer as Record<string, unknown>).mode).toBe("replace");
    expect((next.footer as Record<string, unknown>).custom).toBe(2);
    expect(next.unknown).toEqual({ a: 1 });
  });

  it("parses booleans and clamps refresh intervals", () => {
    expect(applySettingToRawConfig({}, "usage.enabled", "false").usage).toEqual({ enabled: false });
    expect(applySettingToRawConfig({}, "usage.refreshIntervalMs", "1").usage).toEqual({
      refreshIntervalMs: 5_000,
    });
    expect(applySettingToRawConfig({}, "fast.effort", "medium").fast).toEqual({ effort: "medium" });
  });

  it("persists fast.enabled state through the patch context", () => {
    const next = applySettingToRawConfig({}, "fast.enabled", "true", {
      persistState: true,
      active: true,
      desiredActive: true,
    });
    expect(next.active).toBe(true);
    expect(next.desiredActive).toBe(true);
  });

  it("ignores unknown setting ids", () => {
    expect(applySettingToRawConfig({ keep: true }, "not.a.setting", "x")).toEqual({ keep: true });
  });
});

describe("writeConfig", () => {
  it("round-trips and preserves unknown top-level fields", () => {
    const path = join(tempDir(), "nested", "pi-better-grok.json");
    writeConfig(path, { ...DEFAULT_CONFIG, customTopLevel: "keep-me" });
    expect(existsSync(path)).toBe(true);
    const raw = readRawConfig(path);
    expect(raw.customTopLevel).toBe("keep-me");
    expect(typeof readFileSync(path, "utf8")).toBe("string");
  });
});
