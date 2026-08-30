import { describe, expect, it } from "vitest";
import type { ResolvedConfig, SupportedModel } from "../src/config.ts";
import { FastController, modelList, supportsFast } from "../src/fast-controller.ts";

const MODELS: SupportedModel[] = [{ provider: "xai", id: "grok-4.5" }];

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    configPath: "/tmp/none.json",
    projectConfigPath: "/tmp/none.json",
    globalConfigPath: "/tmp/none.json",
    projectConfigExists: false,
    globalConfigExists: false,
    persistState: true,
    active: false,
    desiredActive: false,
    supportedModels: MODELS,
    fast: { effort: "low" },
    usage: {
      enabled: true,
      refreshIntervalMs: 60_000,
      showOnlyOnSubscriptionModels: true,
      showResetTimes: true,
    },
    footer: { mode: "replace" },
    ...overrides,
  } as ResolvedConfig;
}

const ctx = (provider: string, id: string) =>
  ({ model: { provider, id } }) as unknown as Parameters<FastController["debugLines"]>[0];

describe("supportsFast", () => {
  it("matches allow-listed models exactly", () => {
    expect(supportsFast(ctx("xai", "grok-4.5"), MODELS)).toBe(true);
    expect(supportsFast(ctx("xai", "grok-4.6"), MODELS)).toBe(false);
    expect(supportsFast(ctx("anthropic", "claude-x"), MODELS)).toBe(false);
  });

  it("lists models", () => {
    expect(modelList(MODELS)).toBe("xai/grok-4.5");
  });
});

describe("FastController", () => {
  it("starts inactive and stays inactive for ineligible models", () => {
    const controller = new FastController();
    controller.setDesired(ctx("anthropic", "claude-x"), makeConfig(), true);
    expect(controller.desiredActive).toBe(true);
    expect(controller.active).toBe(false);
    expect(controller.statusSegment(ctx("anthropic", "claude-x"), makeConfig())).toBeUndefined();
  });

  it("activates for eligible models and injects reasoning_effort", () => {
    const controller = new FastController();
    const config = makeConfig();
    controller.setDesired(ctx("xai", "grok-4.5"), config, true);
    expect(controller.active).toBe(true);
    expect(controller.statusSegment(ctx("xai", "grok-4.5"), config)).toBe("fast");
    const payload = { model: "grok-4.5", stream: true };
    const injected = controller.injectProviderPayload({ payload }, ctx("xai", "grok-4.5"), config);
    expect(injected).toEqual({ model: "grok-4.5", stream: true, reasoning_effort: "low" });
  });

  it("returns undefined when inactive or payload is malformed", () => {
    const controller = new FastController();
    const config = makeConfig();
    expect(
      controller.injectProviderPayload({ payload: { a: 1 } }, ctx("xai", "grok-4.5"), config),
    ).toBeUndefined();
    controller.setDesired(ctx("xai", "grok-4.5"), config, true);
    expect(
      controller.injectProviderPayload({ payload: "nope" }, ctx("xai", "grok-4.5"), config),
    ).toBeUndefined();
  });

  it("flag init wins over persisted state, but not when persistState is off", () => {
    const controller = new FastController();
    controller.initializeForSession(
      ctx("xai", "grok-4.5"),
      makeConfig({ desiredActive: true }),
      false,
    );
    expect(controller.active).toBe(true);

    const flagController = new FastController();
    flagController.initializeForSession(
      ctx("xai", "grok-4.5"),
      makeConfig({ desiredActive: true, persistState: false }),
      false,
    );
    expect(flagController.desiredActive).toBe(false);
  });

  it("reports state and debug lines", () => {
    const controller = new FastController();
    const config = makeConfig();
    controller.setDesired(ctx("xai", "grok-4.5"), config, true);
    expect(controller.stateText(config)).toBe("Fast mode enabled (reasoning_effort=low)");
    expect(controller.debugLines(ctx("xai", "grok-4.5"), config)).toHaveLength(4);
  });
});
