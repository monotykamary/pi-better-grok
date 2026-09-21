import { describe, expect, it } from "vitest";
import {
  GROK_47_FALLBACK,
  GROK_47_ID,
  GROK_47_NAME,
  grok47FromTemplate,
  registerGrok47OnProviders,
  upsertGrok47,
  type CatalogModel,
} from "../src/xai-models.ts";

function grok(provider: string, id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: extra.baseUrl ?? "https://api.x.ai/v1",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 500_000,
    compat: { supportsLongCacheRetention: false },
    ...extra,
  };
}

describe("upsertGrok47", () => {
  it("returns undefined when the provider catalog is empty", () => {
    expect(upsertGrok47([])).toBeUndefined();
  });

  it("returns undefined when grok-4.7 is already present", () => {
    expect(upsertGrok47([grok("xai", "grok-4.6"), grok("xai", GROK_47_ID)])).toBeUndefined();
  });

  it("appends grok-4.7 cloned from grok-4.6 without dropping siblings", () => {
    const existing = [grok("xai", "grok-4.5"), grok("xai", "grok-4.6")];
    const next = upsertGrok47(existing);
    expect(next?.map((model) => model.id)).toEqual(["grok-4.5", "grok-4.6", GROK_47_ID]);
    const added = next?.at(-1);
    expect(added?.name).toBe(GROK_47_NAME);
    expect(added?.baseUrl).toBe("https://api.x.ai/v1");
    expect(added?.thinkingLevelMap?.xhigh).toBe("xhigh");
    expect(added?.cost).toEqual({
      input: 2,
      output: 6,
      cacheRead: 0.5,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
    });
  });

  it("keeps a non-xAI provider baseUrl when cloning that provider's grok-4.6", () => {
    const existing = [grok("grok-build", "grok-4.6", { baseUrl: "https://build.x.ai/v1" })];
    const added = upsertGrok47(existing)?.at(-1);
    expect(added?.baseUrl).toBe("https://build.x.ai/v1");
    expect(added?.id).toBe(GROK_47_ID);
  });
});

describe("grok47FromTemplate", () => {
  it("falls back to the public xAI card when no sibling exists", () => {
    const model = grok47FromTemplate(undefined);
    expect(model.id).toBe(GROK_47_FALLBACK.id);
    expect(model.api).toBe("openai-responses");
    expect(model.contextWindow).toBe(500_000);
  });
});

describe("registerGrok47OnProviders", () => {
  it("layers grok-4.7 onto present Grok providers only", () => {
    const calls: Array<{ provider: string; ids: string[] }> = [];
    const registered = registerGrok47OnProviders(
      (provider, config) => {
        calls.push({ provider, ids: config.models.map((model) => model.id) });
      },
      [grok("xai", "grok-4.6"), grok("openai", "gpt-5"), grok("grok-build", "grok-4.5")],
    );
    expect(registered).toEqual(["xai", "grok-build"]);
    expect(calls).toEqual([
      { provider: "xai", ids: ["grok-4.6", GROK_47_ID] },
      { provider: "grok-build", ids: ["grok-4.5", GROK_47_ID] },
    ]);
  });

  it("is a no-op when every Grok provider already has grok-4.7", () => {
    const calls: string[] = [];
    const registered = registerGrok47OnProviders(
      (provider) => {
        calls.push(provider);
      },
      [grok("xai", GROK_47_ID)],
    );
    expect(registered).toEqual([]);
    expect(calls).toEqual([]);
  });
});
