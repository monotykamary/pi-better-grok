import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../src/config.ts";
import { isGrokSubscriptionModel, UsageController } from "../src/usage-controller.ts";
import type { UsageSnapshot } from "../src/usage.ts";

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
    supportedModels: [],
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

const snapshot: UsageSnapshot = {
  capturedAt: Date.now(),
  creditUsagePercent: 34,
  periodType: "USAGE_PERIOD_TYPE_WEEKLY",
  periodStart: "2026-08-25T17:34:08+00:00",
  periodEnd: "2026-09-01T17:34:08+00:00",
  subscriptionTier: null,
  isUnifiedBillingUser: true,
  productUsage: [{ product: "GrokBuild", usagePercent: 34 }],
  usedCents: null,
  monthlyLimitCents: null,
  prepaidBalanceCents: null,
};

function makeCtx(overrides: Record<string, unknown> = {}): ExtensionContext {
  return {
    model: { provider: "xai", id: "grok-4.5", contextWindow: 2_000_000, reasoning: true },
    modelRegistry: { isUsingOAuth: () => true },
    ui: { notify: vi.fn() },
    ...overrides,
  } as unknown as ExtensionContext;
}

describe("isGrokSubscriptionModel", () => {
  it("accepts xai providers using OAuth", () => {
    const config = makeConfig();
    expect(isGrokSubscriptionModel(makeCtx(), config)).toBe(true);
  });

  it("hides usage on non-grok providers", () => {
    const config = makeConfig();
    const ctx = makeCtx({ model: { provider: "anthropic", id: "claude-x" } });
    expect(isGrokSubscriptionModel(ctx, config)).toBe(false);
  });

  it("respects the subscription-only gate", () => {
    const config = makeConfig({
      usage: { ...makeConfig().usage, showOnlyOnSubscriptionModels: false },
    });
    const ctx = makeCtx({ modelRegistry: undefined });
    expect(isGrokSubscriptionModel(ctx, config)).toBe(true);
  });
});

describe("UsageController", () => {
  it("fetches, stores, and renders the usage line", async () => {
    const updateFooter = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(snapshot);
    const config = makeConfig();
    const controller = new UsageController(() => config, updateFooter, fetchImpl);
    const ctx = makeCtx();
    await controller.refresh(ctx, { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(controller.snapshot).toEqual(snapshot);
    expect(updateFooter).toHaveBeenCalledWith(ctx);
    expect(controller.statusLine(ctx, config)).toContain("Usage: 66% left");
  });

  it("records errors and hides the status line", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("xAI authentication was rejected."));
    const config = makeConfig();
    const controller = new UsageController(() => config, vi.fn(), fetchImpl);
    const ctx = makeCtx();
    await controller.refresh(ctx, { force: true });
    expect(controller.snapshot).toBeUndefined();
    expect(controller.statusLine(ctx, config)).toBeUndefined();
    expect(controller.formatStatus(ctx)).toContain("Usage unavailable");
  });

  it("notifies on manual refresh and explains ineligibility", async () => {
    const config = makeConfig();
    const fetchImpl = vi.fn().mockResolvedValue(snapshot);
    const controller = new UsageController(() => config, vi.fn(), fetchImpl);
    const ctx = makeCtx({ model: { provider: "anthropic", id: "claude-x" } });
    await controller.refresh(ctx, { notify: true, force: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage hidden: current model is not an xAI subscription model.",
      "info",
    );
  });

  it("serializes concurrent refreshes instead of fetching in parallel", async () => {
    const config = makeConfig();
    let release: (value: UsageSnapshot) => void = () => {};
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return new Promise<UsageSnapshot>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(snapshot);
    });
    const controller = new UsageController(() => config, vi.fn(), fetchImpl);
    const ctx = makeCtx();
    const first = controller.refresh(ctx, { force: true });
    const second = controller.refresh(ctx, { notify: true, force: true });
    release(snapshot);
    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(controller.snapshot).toEqual(snapshot);
  });

  it("stops polling on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig({ usage: { ...makeConfig().usage, refreshIntervalMs: 10 } });
      const fetchImpl = vi.fn().mockResolvedValue(snapshot);
      const controller = new UsageController(() => config, vi.fn(), fetchImpl);
      const ctx = makeCtx();
      controller.start(ctx);
      controller.shutdown();
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
