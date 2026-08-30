import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "./paths.ts";

// Native pi providers that may hold an xAI OAuth credential, in preference order.
// `xai` is pi-core's native provider; `xai-oauth`/`xai-auth` come from community
// provider extensions that share the same OAuth surface.
export const XAI_PROVIDER_IDS = ["xai", "xai-oauth", "xai-auth"] as const;
export type XaiProviderId = (typeof XAI_PROVIDER_IDS)[number];

export const GROK_CLI_AUTH_SCOPE_KEY = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_CLI_LEGACY_AUTH_SCOPE_KEY = "https://accounts.x.ai/sign-in";

export type GrokCredential = {
  token: string;
  source: "modelRegistry" | "authFile" | "grokCli";
};

export function isXaiProvider(provider: unknown): provider is XaiProviderId {
  return typeof provider === "string" && (XAI_PROVIDER_IDS as readonly string[]).includes(provider);
}

export function providerIdsFor(ctx: Pick<ExtensionContext, "model">): XaiProviderId[] {
  if (isXaiProvider(ctx?.model?.provider)) return [ctx.model.provider];
  return [...XAI_PROVIDER_IDS];
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function oauthAccessFromStored(stored: unknown): string | null {
  if (
    stored &&
    typeof stored === "object" &&
    (stored as Record<string, unknown>).type === "oauth"
  ) {
    const record = stored as { access?: unknown; expires?: unknown };
    if (typeof record.access === "string" && record.access) {
      const expires = parseExpiry(record.expires);
      if (expires !== undefined && expires <= Date.now()) return null;
      return record.access;
    }
  }
  return null;
}

function extractBearerToken(authLike: unknown): string | null {
  if (!authLike || typeof authLike !== "object") return null;
  const payload = authLike as { apiKey?: unknown; headers?: Record<string, string> };
  if (typeof payload.apiKey === "string" && payload.apiKey) return payload.apiKey;
  const authorization =
    typeof payload.headers?.Authorization === "string" ? payload.headers.Authorization : "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim() || null
    : null;
}

function tokenFromAuthResolution(resolution: unknown): string | null {
  if (!resolution || typeof resolution !== "object") return null;
  const value = resolution as {
    ok?: unknown;
    auth?: unknown;
    apiKey?: unknown;
    headers?: Record<string, string>;
  };
  if (value.auth && typeof value.auth === "object") return extractBearerToken(value.auth);
  if ("ok" in value) {
    if (value.ok !== true) return null;
    return extractBearerToken(value);
  }
  return extractBearerToken(value);
}

function registryUsesOAuth(registry: unknown, model: unknown, providerId: string): boolean {
  try {
    const reg = registry as {
      isUsingOAuth?: (model: unknown) => boolean;
      authStorage?: { get?: (id: string) => unknown };
    };
    if (typeof reg?.isUsingOAuth === "function") return reg.isUsingOAuth(model) === true;
    const stored = reg?.authStorage?.get?.(providerId) as
      | { type?: unknown; access?: unknown }
      | undefined;
    return stored?.type === "oauth" && typeof stored.access === "string" && !!stored.access;
  } catch {
    return false;
  }
}

async function resolveRegistryToken(
  registry: unknown,
  model: unknown,
  modelRuntime: unknown,
): Promise<string | null> {
  const reg = registry as {
    getAuth?: (model: unknown) => Promise<unknown>;
    getApiKeyAndHeaders?: (model: unknown) => Promise<unknown>;
    getProviderAuth?: (providerId: string) => Promise<unknown>;
  };
  const runtime = modelRuntime as { getAuth?: (model: unknown) => Promise<unknown> } | undefined;
  if (runtime && typeof runtime.getAuth === "function") {
    try {
      const token = tokenFromAuthResolution(await runtime.getAuth(model));
      if (token) return token;
    } catch {
      // Fall through to registry projections.
    }
  }
  if (reg && typeof reg.getAuth === "function") {
    try {
      const token = tokenFromAuthResolution(await reg.getAuth(model));
      if (token) return token;
    } catch {
      // Fall through.
    }
  }
  if (typeof reg?.getApiKeyAndHeaders === "function") {
    try {
      const token = tokenFromAuthResolution(await reg.getApiKeyAndHeaders(model));
      if (token) return token;
    } catch {
      // Fall through.
    }
  }
  if (typeof reg?.getProviderAuth === "function") {
    try {
      const providerId =
        typeof (model as { provider?: unknown })?.provider === "string"
          ? (model as { provider: string }).provider
          : "xai";
      return tokenFromAuthResolution(await reg.getProviderAuth(providerId));
    } catch {
      return null;
    }
  }
  return null;
}

export function piAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return piAgentDir(env) + "/auth.json";
}

function grokCliAuthPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.PI_GROK_AUTH_PATH?.trim();
  if (override) return override;
  return home + "/.grok/auth.json";
}

export function readPiStoredOAuthToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const data = readJsonFile(piAuthPath(env));
  if (!data) return null;
  for (const providerId of XAI_PROVIDER_IDS) {
    const token = oauthAccessFromStored(data[providerId]);
    if (token) return token;
  }
  return null;
}

export function readGrokCliToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const data = readJsonFile(grokCliAuthPath(env));
  if (!data) return null;
  for (const scopeKey of [GROK_CLI_AUTH_SCOPE_KEY, GROK_CLI_LEGACY_AUTH_SCOPE_KEY]) {
    const entry = data[scopeKey] as
      | { key?: unknown; access_token?: unknown; token?: unknown; expires_at?: unknown }
      | undefined;
    if (entry && typeof entry === "object") {
      const access = [entry.key, entry.access_token, entry.token].find(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (access) {
        const expires = parseExpiry(entry.expires_at);
        if (expires !== undefined && expires <= Date.now()) return null;
        return access;
      }
    }
  }
  const top = data.access_token ?? data.token;
  return typeof top === "string" && top ? top : null;
}

export async function resolveGrokCredential(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
): Promise<GrokCredential | null> {
  const registry = (ctx as { modelRegistry?: unknown })?.modelRegistry;
  const modelRuntime = (ctx as { modelRuntime?: unknown })?.modelRuntime;
  if (registry && typeof registry === "object" && "find" in registry) {
    const reg = registry as { find: (provider: string, id: string) => unknown };
    for (const providerId of providerIdsFor(ctx)) {
      const candidates = [
        ctx?.model?.provider === providerId ? ctx.model : undefined,
        reg.find(
          providerId,
          ctx?.model?.provider === providerId ? (ctx.model?.id ?? "") : "grok-4.5",
        ),
        reg.find(providerId, "grok-4.5"),
      ].filter(Boolean);
      for (const model of candidates) {
        if (!registryUsesOAuth(registry, model, providerId)) continue;
        const token = await resolveRegistryToken(registry, model, modelRuntime);
        if (token) return { token, source: "modelRegistry" };
      }
    }
  }
  const stored = readPiStoredOAuthToken();
  if (stored) return { token: stored, source: "authFile" };
  const grok = readGrokCliToken();
  if (grok) return { token: grok, source: "grokCli" };
  return null;
}

export function hasGrokOAuth(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): boolean {
  const registry = (ctx as { modelRegistry?: unknown })?.modelRegistry;
  if (registry && typeof registry === "object" && "find" in registry) {
    for (const providerId of providerIdsFor(ctx)) {
      const reg = registry as { find: (provider: string, id: string) => unknown };
      const candidates = [
        ctx?.model?.provider === providerId ? ctx.model : undefined,
        reg.find(providerId, "grok-4.5"),
      ].filter(Boolean);
      if (candidates.some((model) => registryUsesOAuth(registry, model, providerId))) return true;
    }
  }
  return !!(readPiStoredOAuthToken() || readGrokCliToken());
}
