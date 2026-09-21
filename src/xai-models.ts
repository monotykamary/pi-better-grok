import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const GROK_47_ID = "grok-4.7";
export const GROK_47_NAME = "Grok 4.7";

/** Providers that share Grok model ids and should pick up 4.7 until pi-core ships it. */
export const GROK_CUSTOM_MODEL_PROVIDERS = ["xai", "xai-oauth", "xai-auth", "grok-build"] as const;

const GROK_47_LONG_CONTEXT_TIER = {
  inputTokensAbove: 200_000,
  input: 4,
  output: 12,
  cacheRead: 1,
  cacheWrite: 0,
} as const;

const GROK_47_COST = {
  input: 2,
  output: 6,
  cacheRead: 0.5,
  cacheWrite: 0,
  tiers: [{ ...GROK_47_LONG_CONTEXT_TIER }],
};

const GROK_47_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null,
} as const;

/**
 * Native xAI Grok 4.7, cloned from pi-core's grok-4.6 catalog plus the public
 * 4.7 card. Used as an in-memory fallback when models.json cannot be updated.
 */
export const GROK_47_FALLBACK: ProviderModelConfig = {
  id: GROK_47_ID,
  name: GROK_47_NAME,
  api: "openai-responses",
  baseUrl: "https://api.x.ai/v1",
  reasoning: true,
  thinkingLevelMap: { ...GROK_47_THINKING_LEVEL_MAP },
  input: ["text", "image"],
  cost: { ...GROK_47_COST, tiers: [{ ...GROK_47_LONG_CONTEXT_TIER }] },
  contextWindow: 500_000,
  maxTokens: 500_000,
  compat: { supportsLongCacheRetention: false },
};

/**
 * models.json custom model layered onto builtin `xai`. api/baseUrl are omitted so
 * pi inherits them from grok-4.6 instead of replacing the provider catalog.
 */
export const GROK_47_MODELS_JSON_DEFINITION = {
  id: GROK_47_ID,
  name: GROK_47_NAME,
  reasoning: true,
  thinkingLevelMap: { ...GROK_47_THINKING_LEVEL_MAP },
  input: ["text", "image"] as Array<"text" | "image">,
  cost: { ...GROK_47_COST, tiers: [{ ...GROK_47_LONG_CONTEXT_TIER }] },
  contextWindow: 500_000,
  maxTokens: 500_000,
  compat: { supportsLongCacheRetention: false },
};

/** Structural catalog slice; avoids a hard pi-ai import from this package. */
export type CatalogModel = {
  id: string;
  name: string;
  api?: ProviderModelConfig["api"];
  provider: string;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: ProviderModelConfig["thinkingLevelMap"];
  input: ProviderModelConfig["input"];
  cost: ProviderModelConfig["cost"];
  promptCache?: ProviderModelConfig["promptCache"];
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ProviderModelConfig["compat"];
};

export function catalogModelToProviderConfig(model: CatalogModel): ProviderModelConfig {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    promptCache: model.promptCache,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    compat: model.compat,
  };
}

export function grok47FromTemplate(template: CatalogModel | undefined): ProviderModelConfig {
  if (!template) {
    return {
      ...GROK_47_FALLBACK,
      cost: { ...GROK_47_FALLBACK.cost, tiers: [{ ...GROK_47_LONG_CONTEXT_TIER }] },
    };
  }
  const thinkingLevelMap = {
    ...template.thinkingLevelMap,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  };
  return {
    ...catalogModelToProviderConfig(template),
    id: GROK_47_ID,
    name: GROK_47_NAME,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: Math.max(template.contextWindow, 500_000),
    maxTokens: Math.max(template.maxTokens, 500_000),
    thinkingLevelMap,
    cost: {
      ...template.cost,
      input: 2,
      output: 6,
      cacheRead: template.cost.cacheRead || 0.5,
      cacheWrite: template.cost.cacheWrite ?? 0,
      tiers: template.cost.tiers ?? [{ ...GROK_47_LONG_CONTEXT_TIER }],
    },
  };
}

/**
 * Extension registerProvider models replace that provider's catalog.
 * Return the existing models plus grok-4.7, or undefined when 4.7 is already present
 * or the provider has nothing to layer onto.
 */
export function upsertGrok47(existing: readonly CatalogModel[]): ProviderModelConfig[] | undefined {
  if (existing.length === 0) return undefined;
  if (existing.some((model) => model.id === GROK_47_ID)) return undefined;
  const template =
    existing.find((model) => model.id === "grok-4.6") ??
    existing.find((model) => model.id === "grok-4.5") ??
    existing[0];
  return [...existing.map(catalogModelToProviderConfig), grok47FromTemplate(template)];
}

export type Grok47Registration = { provider: string; models: ProviderModelConfig[] };

export function grok47Registrations(all: readonly CatalogModel[]): Grok47Registration[] {
  const byProvider = new Map<string, CatalogModel[]>();
  for (const model of all) {
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  const registrations: Grok47Registration[] = [];
  for (const provider of GROK_CUSTOM_MODEL_PROVIDERS) {
    const models = upsertGrok47(byProvider.get(provider) ?? []);
    if (models) registrations.push({ provider, models });
  }
  return registrations;
}

export function registerGrok47OnProviders(
  registerProvider: (name: string, config: { models: ProviderModelConfig[] }) => void,
  all: readonly CatalogModel[],
): string[] {
  const registered: string[] = [];
  for (const entry of grok47Registrations(all)) {
    registerProvider(entry.provider, { models: entry.models });
    registered.push(entry.provider);
  }
  return registered;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function upsertGrok47InModelsJson(raw: unknown): {
  next: Record<string, unknown>;
  changed: boolean;
} {
  const root = { ...asObject(raw) };
  const providers = { ...asObject(root.providers) };
  const xai = { ...asObject(providers.xai) };
  const models = Array.isArray(xai.models) ? [...xai.models] : [];
  const alreadyPresent = models.some((entry) => asObject(entry)?.id === GROK_47_ID);
  if (alreadyPresent) {
    return { next: asObject(raw) ?? root, changed: false };
  }
  models.push({
    ...GROK_47_MODELS_JSON_DEFINITION,
    thinkingLevelMap: { ...GROK_47_THINKING_LEVEL_MAP },
    input: [...GROK_47_MODELS_JSON_DEFINITION.input],
    cost: { ...GROK_47_COST, tiers: [{ ...GROK_47_LONG_CONTEXT_TIER }] },
    compat: { ...GROK_47_MODELS_JSON_DEFINITION.compat },
  });
  xai.models = models;
  providers.xai = xai;
  root.providers = providers;
  return { next: root, changed: true };
}

export function grok47ModelsJsonPath(agentDir: string): string {
  return join(agentDir, "models.json");
}

export function ensureGrok47InModelsJsonFile(agentDir: string): boolean {
  const path = grok47ModelsJsonPath(agentDir);
  let parsed: unknown = {};
  if (existsSync(path)) {
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
  }
  const { next, changed } = upsertGrok47InModelsJson(parsed);
  if (!changed) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

export type SessionModelRef = { provider: string; modelId: string };

export function lastSessionModel(
  entries: ReadonlyArray<{ type: string; provider?: string; modelId?: string }>,
): SessionModelRef | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string"
    ) {
      return { provider: entry.provider, modelId: entry.modelId };
    }
  }
  return undefined;
}

export function shouldRestoreGrok47(
  current: { provider?: string; id?: string } | undefined,
  saved: SessionModelRef | undefined,
): boolean {
  if (!saved || saved.modelId !== GROK_47_ID) return false;
  return current?.id !== saved.modelId || current?.provider !== saved.provider;
}
