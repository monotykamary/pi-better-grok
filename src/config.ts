import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_BASENAME, logPrefix } from "./identity.ts";
import { piAgentDir } from "./paths.ts";

export const FOOTER_MODES = ["replace", "status", "off"] as const;
export const FAST_EFFORTS = ["low", "medium", "high"] as const;

export const DEFAULT_SUPPORTED_MODELS = [
  "xai/grok-4.6",
  "xai/grok-4.5",
  "xai-oauth/grok-4.6",
  "xai-oauth/grok-4.5",
  "grok-build/grok-4.6",
  "grok-build/grok-4.5",
] as const;

export type FooterMode = (typeof FOOTER_MODES)[number];
export type FastEffort = (typeof FAST_EFFORTS)[number];

export type FastConfig = { effort?: FastEffort };
export type UsageConfig = {
  enabled?: boolean;
  refreshIntervalMs?: number;
  showOnlyOnSubscriptionModels?: boolean;
  showResetTimes?: boolean;
};
export type FooterConfig = { mode?: FooterMode };

export interface ConfigFile {
  persistState?: boolean;
  active?: boolean;
  desiredActive?: boolean;
  supportedModels?: string[];
  fast?: FastConfig;
  usage?: UsageConfig;
  footer?: FooterConfig;
}

export interface SupportedModel {
  provider: string;
  id: string;
}

export interface ResolvedConfig {
  configPath: string;
  projectConfigPath: string;
  globalConfigPath: string;
  projectConfigExists: boolean;
  globalConfigExists: boolean;
  persistState: boolean;
  active: boolean;
  desiredActive: boolean;
  supportedModels: SupportedModel[];
  fast: Required<FastConfig>;
  usage: Required<UsageConfig>;
  footer: Required<FooterConfig>;
}

export const DEFAULT_FAST_CONFIG: Required<FastConfig> = { effort: "low" };
export const DEFAULT_USAGE_CONFIG: Required<UsageConfig> = {
  enabled: true,
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};
export const DEFAULT_FOOTER_CONFIG: Required<FooterConfig> = { mode: "replace" };
export const DEFAULT_CONFIG: ConfigFile = {
  persistState: true,
  active: false,
  desiredActive: false,
  supportedModels: [...DEFAULT_SUPPORTED_MODELS],
  fast: DEFAULT_FAST_CONFIG,
  usage: DEFAULT_USAGE_CONFIG,
  footer: DEFAULT_FOOTER_CONFIG,
};

type SettingsOptionSection = "footer" | "usage" | "fast";

export type SettingsOptionDescriptor = {
  id: string;
  section: SettingsOptionSection;
  key: string;
  label: string;
  description: string;
  values?: readonly string[];
  parse(rawValue: string): boolean | number | string;
  current(config: ResolvedConfig): string;
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumberInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function parseModelKey(key: string): SupportedModel | undefined {
  const separator = key.indexOf("/");
  if (separator <= 0 || separator === key.length - 1) return undefined;
  const provider = key.slice(0, separator).trim();
  const id = key.slice(separator + 1).trim();
  if (!provider || !id) return undefined;
  return { provider, id };
}

export function parseModels(value: unknown): SupportedModel[] {
  const entries = Array.isArray(value) ? value : [...DEFAULT_SUPPORTED_MODELS];
  const models: SupportedModel[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const model = parseModelKey(entry);
    if (model) models.push(model);
  }
  return models;
}

export function normalizeModelKeys(models: SupportedModel[]): string[] {
  return models.map((model) => `${model.provider}/${model.id}`);
}

function mergedSection<T extends object>(
  fallback: T,
  globalValue: unknown,
  projectValue: unknown,
): Required<T> {
  const global = globalValue && typeof globalValue === "object" ? globalValue : {};
  const project = projectValue && typeof projectValue === "object" ? projectValue : {};
  return { ...fallback, ...global, ...project } as Required<T>;
}

export const FOOTER_SETTING_DESCRIPTORS: SettingsOptionDescriptor[] = [
  {
    id: "footer.mode",
    section: "footer",
    key: "mode",
    label: "Footer mode",
    description: "replace: custom footer. status: status line widget. off: hide.",
    values: FOOTER_MODES,
    parse: (rawValue) => asEnum(rawValue, FOOTER_MODES, DEFAULT_FOOTER_CONFIG.mode),
    current: (config) => config.footer.mode,
  },
];

export const USAGE_SETTING_DESCRIPTORS: SettingsOptionDescriptor[] = [
  {
    id: "usage.enabled",
    section: "usage",
    key: "enabled",
    label: "Usage display",
    description: "Show Grok subscription usage in the footer.",
    values: ["true", "false"],
    parse: (rawValue) => rawValue === "true",
    current: (config) => String(config.usage.enabled),
  },
  {
    id: "usage.refreshIntervalMs",
    section: "usage",
    key: "refreshIntervalMs",
    label: "Usage refresh interval",
    description: "How often to poll Grok billing (milliseconds).",
    values: ["30000", "60000", "120000", "300000"],
    parse: (rawValue) =>
      asNumberInRange(Number(rawValue), DEFAULT_USAGE_CONFIG.refreshIntervalMs, 5_000, 3_600_000),
    current: (config) => String(config.usage.refreshIntervalMs),
  },
  {
    id: "usage.showOnlyOnSubscriptionModels",
    section: "usage",
    key: "showOnlyOnSubscriptionModels",
    label: "Only on subscription models",
    description: "Hide usage unless the current model uses xAI OAuth.",
    values: ["true", "false"],
    parse: (rawValue) => rawValue === "true",
    current: (config) => String(config.usage.showOnlyOnSubscriptionModels),
  },
  {
    id: "usage.showResetTimes",
    section: "usage",
    key: "showResetTimes",
    label: "Show reset times",
    description: "Append the billing period reset countdown to the usage line.",
    values: ["true", "false"],
    parse: (rawValue) => rawValue === "true",
    current: (config) => String(config.usage.showResetTimes),
  },
];

export const FAST_SETTING_DESCRIPTORS: SettingsOptionDescriptor[] = [
  {
    id: "fast.effort",
    section: "fast",
    key: "effort",
    label: "Fast effort",
    description: "reasoning_effort injected while fast mode is enabled.",
    values: FAST_EFFORTS,
    parse: (rawValue) => asEnum(rawValue, FAST_EFFORTS, DEFAULT_FAST_CONFIG.effort),
    current: (config) => config.fast.effort,
  },
];

export const SETTINGS_OPTION_DESCRIPTORS: SettingsOptionDescriptor[] = [
  ...FOOTER_SETTING_DESCRIPTORS,
  ...USAGE_SETTING_DESCRIPTORS,
  ...FAST_SETTING_DESCRIPTORS,
];

export const SETTINGS_OPTION_BY_ID = new Map(
  SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

export type SettingPatchContext = {
  persistState?: boolean;
  active?: boolean;
  desiredActive?: boolean;
};

export function applySettingToRawConfig(
  current: Record<string, unknown>,
  id: string,
  rawValue: string,
  context: SettingPatchContext = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  if (id === "fast.enabled") {
    const bool = rawValue === "true";
    if (context.persistState) {
      next.active = context.active ?? bool;
      next.desiredActive = context.desiredActive ?? bool;
    }
    return next;
  }
  const descriptor = SETTINGS_OPTION_BY_ID.get(id);
  if (!descriptor) return next;
  const parsedValue = descriptor.parse(rawValue);
  const currentSection = next[descriptor.section];
  const section =
    currentSection && typeof currentSection === "object" && !Array.isArray(currentSection)
      ? { ...(currentSection as Record<string, unknown>) }
      : {};
  section[descriptor.key] = parsedValue;
  next[descriptor.section] = section;
  return next;
}

export function configPaths(cwd: string, home = homedir(), env = process.env) {
  return {
    project: join(cwd, ".pi", "extensions", CONFIG_BASENAME),
    global: join(piAgentDir(env, home), "extensions", CONFIG_BASENAME),
  };
}

export function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${logPrefix()} Failed to read ${path}: ${message}`);
    return {};
  }
}

export function writeConfig(path: string, config: ConfigFile | Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${logPrefix()} Failed to write ${path}: ${message}`);
  }
}

function firstDefined(
  globalRaw: Record<string, unknown>,
  projectRaw: Record<string, unknown>,
  key: string,
): unknown {
  if (globalRaw[key] !== undefined) return globalRaw[key];
  return projectRaw[key];
}

export function resolveConfig(cwd: string, home = homedir(), env = process.env): ResolvedConfig {
  const paths = configPaths(cwd, home, env);
  const projectRaw = readRawConfig(paths.project);
  const globalRaw = readRawConfig(paths.global);
  const projectHasContent = Object.keys(projectRaw).length > 0;
  return {
    configPath: projectHasContent ? paths.project : paths.global,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
    projectConfigExists: existsSync(paths.project),
    globalConfigExists: existsSync(paths.global),
    persistState: asBoolean(firstDefined(globalRaw, projectRaw, "persistState"), true),
    active: asBoolean(firstDefined(globalRaw, projectRaw, "active"), false),
    desiredActive: asBoolean(firstDefined(globalRaw, projectRaw, "desiredActive"), false),
    supportedModels: parseModels(firstDefined(globalRaw, projectRaw, "supportedModels")),
    fast: mergedSection(DEFAULT_FAST_CONFIG, globalRaw.fast, projectRaw.fast),
    usage: mergedSection(DEFAULT_USAGE_CONFIG, globalRaw.usage, projectRaw.usage),
    footer: mergedSection(DEFAULT_FOOTER_CONFIG, globalRaw.footer, projectRaw.footer),
  };
}
