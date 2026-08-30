/**
 * Better Grok for pi.
 *
 * Mirrors pi-better-openai's UX for the xAI/Grok side: fast mode
 * (reasoning_effort override), SuperGrok subscription usage in the footer,
 * footer polish, and a settings picker. Usage rides the revision-pinned
 * cli-chat-proxy.grok.com identity-first billing surface using pi's native
 * xAI OAuth credential.
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingsListTheme } from "@earendil-works/pi-tui";
import { CONFIG_BASENAME, STATUS_KEY } from "./src/identity.ts";
import { formatTokens, sanitizeStatusText, truncateToWidth, visibleWidth } from "./src/format.ts";
import {
  applySettingToRawConfig,
  configPaths,
  DEFAULT_CONFIG,
  DEFAULT_SUPPORTED_MODELS,
  FAST_SETTING_DESCRIPTORS,
  FOOTER_SETTING_DESCRIPTORS,
  normalizeModelKeys,
  parseModelKey,
  parseModels,
  readRawConfig,
  resolveConfig,
  USAGE_SETTING_DESCRIPTORS,
  writeConfig,
  type ResolvedConfig,
} from "./src/config.ts";
import {
  formatPercent,
  formatResetCountdown,
  formatUsageDetail,
  formatUsageSnapshot,
  parseUsageSnapshot,
  requestGrokUsage,
  UsageError,
  type UsageSnapshot,
} from "./src/usage.ts";
import {
  readGrokCliToken,
  readPiStoredOAuthToken,
  resolveGrokCredential,
  XAI_PROVIDER_IDS,
} from "./src/grok-auth.ts";
import { currentModelKey, FastController, modelList, supportsFast } from "./src/fast-controller.ts";
import { isGrokSubscriptionModel, UsageController } from "./src/usage-controller.ts";
import { sep } from "node:path";

// pi-core's getSettingsListTheme pulls the host module graph into this
// extension's loader. The settings picker is a command-time surface, so the
// theme loads when it first opens.
let loadedSettingsListTheme: SettingsListTheme | undefined;
const loadSettingsListTheme = async (): Promise<SettingsListTheme> => {
  loadedSettingsListTheme ??= (
    await import("@earendil-works/pi-coding-agent")
  ).getSettingsListTheme();
  return loadedSettingsListTheme;
};
const requireSettingsListTheme = (): SettingsListTheme => {
  if (!loadedSettingsListTheme) {
    throw new Error("Settings list theme accessed before /grok-settings preload");
  }
  return loadedSettingsListTheme;
};

const COMMAND = "grok-fast";
const USAGE_COMMAND = "grok-usage";
const SETTINGS_COMMAND = "grok-settings";
const FLAG = "grok-fast";

type SettingsPickerItem = {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
};

function hasTerminalUI(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI);
}

export function abbreviateHomePath(
  path: string,
  home = process.env.HOME || process.env.USERPROFILE,
): string {
  if (!home) return path;
  if (path === home) return "~";
  const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(homePrefix) ? `~/${path.slice(homePrefix.length)}` : path;
}

export default function betterGrok(pi: ExtensionAPI): void {
  const fetchUsageSnapshot = async (ctx: ExtensionContext): Promise<UsageSnapshot> => {
    const credential = await resolveGrokCredential(ctx);
    if (!credential) {
      throw new UsageError(
        "auth",
        "No xAI OAuth credential found. Run /login xai and select Use a subscription.",
      );
    }
    const { snapshot } = await requestGrokUsage(credential);
    return snapshot;
  };

  const fastController = new FastController();
  let cachedConfig: ResolvedConfig | undefined;
  let footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let footerInstalled = false;
  let statusInstalled = false;
  let statusWidgetInstalled = false;
  let contextUsageCached = false;
  let cachedContextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
  let cachedContextLeafId: string | null | undefined;
  let cachedContextModel: ExtensionContext["model"];
  let sessionNameCached = false;
  let cachedSessionNameLeafId: string | null | undefined;
  let cachedSessionName: string | undefined;
  const usageController = new UsageController(config, updateFooter, fetchUsageSnapshot);

  function refresh(ctx: ExtensionContext): ResolvedConfig {
    cachedConfig = resolveConfig(ctx.cwd || process.cwd());
    return cachedConfig;
  }

  function config(ctx: ExtensionContext): ResolvedConfig {
    return cachedConfig ?? refresh(ctx);
  }

  function persist(nextConfig: ResolvedConfig): void {
    cachedConfig = {
      ...nextConfig,
      active: fastController.active,
      desiredActive: fastController.desiredActive,
    };
    if (!nextConfig.persistState) return;
    writeConfig(nextConfig.configPath, {
      ...readRawConfig(nextConfig.configPath),
      active: fastController.active,
      desiredActive: fastController.desiredActive,
    });
  }

  function refreshFooterTotals(ctx: ExtensionContext): void {
    footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      footerTotals.input += entry.message.usage.input;
      footerTotals.output += entry.message.usage.output;
      footerTotals.cacheRead += entry.message.usage.cacheRead;
      footerTotals.cacheWrite += entry.message.usage.cacheWrite;
      footerTotals.cost += entry.message.usage.cost.total;
    }
  }

  function invalidateContextUsage(): void {
    contextUsageCached = false;
    cachedContextUsage = undefined;
    cachedContextLeafId = undefined;
    cachedContextModel = undefined;
  }

  function contextUsage(ctx: ExtensionContext): ReturnType<ExtensionContext["getContextUsage"]> {
    const leafId = ctx.sessionManager.getLeafId();
    const model = ctx.model;
    if (!contextUsageCached || leafId !== cachedContextLeafId || model !== cachedContextModel) {
      cachedContextUsage = ctx.getContextUsage();
      contextUsageCached = true;
      cachedContextLeafId = leafId;
      cachedContextModel = model;
    }
    return cachedContextUsage;
  }

  function sessionName(ctx: ExtensionContext): string | undefined {
    const leafId = ctx.sessionManager.getLeafId();
    if (!sessionNameCached || leafId !== cachedSessionNameLeafId) {
      cachedSessionName = ctx.sessionManager.getSessionName();
      cachedSessionNameLeafId = leafId;
      sessionNameCached = true;
    }
    return cachedSessionName;
  }

  function invalidateSessionName(): void {
    sessionNameCached = false;
    cachedSessionNameLeafId = undefined;
    cachedSessionName = undefined;
  }

  pi.registerFlag(FLAG, {
    description: "Start with Grok fast mode enabled (reasoning_effort override)",
    type: "boolean",
    default: false,
  });

  function setActive(ctx: ExtensionContext, next: boolean): void {
    const nextConfig = refresh(ctx);
    fastController.setDesired(ctx, nextConfig, next);
    persist(nextConfig);
    updateFooter(ctx);
    if (next && !fastController.active) {
      ctx.ui.notify(fastController.unsupportedRequestMessage(ctx, nextConfig), "warning");
      return;
    }
    ctx.ui.notify(fastController.stateText(nextConfig), "info");
  }

  function formatDebugStatus(ctx: ExtensionContext): string {
    const cfg = config(ctx);
    return [
      ...fastController.debugLines(ctx, cfg),
      `Footer mode: ${cfg.footer.mode}`,
      "",
      usageController.formatDebug(ctx),
    ].join("\n");
  }

  pi.registerCommand(COMMAND, {
    description: "Toggle Grok fast mode",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) return setActive(ctx, !fastController.desiredActive);
      ctx.ui.notify("Usage: /grok-fast", "error");
    },
  });

  pi.registerCommand(USAGE_COMMAND, {
    description: "Show Grok subscription usage status",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "debug") {
        ctx.ui.notify(formatDebugStatus(ctx), "info");
        return;
      }
      await usageController.refresh(ctx, { notify: true, force: true });
    },
  });

  function settingsItems(
    descriptors:
      | typeof FOOTER_SETTING_DESCRIPTORS
      | typeof USAGE_SETTING_DESCRIPTORS
      | typeof FAST_SETTING_DESCRIPTORS,
    cfg: ResolvedConfig,
  ): SettingsPickerItem[] {
    return descriptors.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      description: descriptor.description,
      currentValue: descriptor.current(cfg),
      values: descriptor.values ? [...descriptor.values] : undefined,
    }));
  }

  function buildSettingsSections(cfg: ResolvedConfig): SettingsPickerItem[] {
    return [
      { id: "section.footer", label: "Footer", currentValue: "" },
      ...settingsItems(FOOTER_SETTING_DESCRIPTORS, cfg),
      { id: "section.usage", label: "Usage", currentValue: "" },
      ...settingsItems(USAGE_SETTING_DESCRIPTORS, cfg),
      { id: "section.fast", label: "Fast mode", currentValue: "" },
      ...settingsItems(FAST_SETTING_DESCRIPTORS, cfg),
    ];
  }

  function writeSetting(ctx: ExtensionContext, id: string, rawValue: string): void {
    const cfg = refresh(ctx);
    const current = readRawConfig(cfg.configPath);
    if (id === "fast.enabled") {
      fastController.setDesired(ctx, cfg, rawValue === "true");
    }
    const nextRawConfig = applySettingToRawConfig(current, id, rawValue, {
      persistState: cfg.persistState,
      active: fastController.active,
      desiredActive: fastController.desiredActive,
    });
    writeConfig(cfg.configPath, nextRawConfig);
    if (id === "usage.refreshIntervalMs") usageController.restart(ctx);
    updateFooter(ctx);
  }

  async function showSettingsPicker(ctx: ExtensionContext): Promise<void> {
    if (!hasTerminalUI(ctx)) {
      ctx.ui.notify("Better Grok settings require interactive TUI mode.", "warning");
      return;
    }
    await loadSettingsListTheme();
    try {
      await ctx.ui.custom((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(
          new (class {
            render(_width: number) {
              const cfg = config(ctx);
              return [
                theme.fg("accent", theme.bold("Better Grok Settings")),
                theme.fg("dim", cfg.configPath),
                "",
              ];
            }
            invalidate() {}
          })(),
        );
        const settingsList = new SettingsList(
          buildSettingsSections(refresh(ctx)),
          8,
          requireSettingsListTheme(),
          (id, newValue) => {
            if (!id.startsWith("section.")) writeSetting(ctx, id, newValue);
            settingsList.updateValue(
              id,
              buildSettingsSections(config(ctx)).find((item) => item.id === id)?.currentValue ??
                newValue,
            );
            tui.requestRender();
          },
          () => done(undefined),
          { enableSearch: true },
        );
        container.addChild(settingsList);
        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput(data);
            tui.requestRender();
          },
        };
      });
    } finally {
      updateFooter(ctx);
    }
  }

  pi.registerCommand(SETTINGS_COMMAND, {
    description: "Open Better Grok settings picker",
    handler: async (_args, ctx) => {
      await showSettingsPicker(ctx);
    },
  });

  function installFooter(ctx: ExtensionContext): void {
    if (footerInstalled) return;
    footerInstalled = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
      return {
        dispose: () => {
          unsubscribe?.();
          footerInstalled = false;
        },
        invalidate() {},
        render(width: number): string[] {
          const totalInput = footerTotals.input;
          const totalOutput = footerTotals.output;
          const totalCacheRead = footerTotals.cacheRead;
          const totalCacheWrite = footerTotals.cacheWrite;
          const totalCost = footerTotals.cost;

          let pwd = abbreviateHomePath(ctx.sessionManager.getCwd());
          const branch = footerData.getGitBranch?.();
          if (branch) pwd = `${pwd} (${branch})`;
          const currentSessionName = sessionName(ctx);
          if (currentSessionName) pwd = `${pwd} • ${currentSessionName}`;

          const parts: string[] = [];
          if (totalInput) parts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) parts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) parts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) parts.push(`W${formatTokens(totalCacheWrite)}`);

          const usingSubscription = ctx.model
            ? typeof ctx.modelRegistry?.isUsingOAuth === "function"
              ? ctx.modelRegistry.isUsingOAuth(ctx.model)
              : false
            : false;
          if (totalCost || usingSubscription) {
            parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
          }

          const currentContextUsage = contextUsage(ctx);
          const contextWindow = currentContextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = currentContextUsage?.percent ?? 0;
          const contextPercent =
            currentContextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
          const contextDisplay =
            contextPercent === "?"
              ? `?/${formatTokens(contextWindow)} (auto)`
              : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
          const contextText =
            contextPercentValue > 90
              ? theme.fg("error", contextDisplay)
              : contextPercentValue > 70
                ? theme.fg("warning", contextDisplay)
                : contextDisplay;
          parts.push(contextText);

          const cfg = config(ctx);
          const usageStatusLine = usageController.statusLine(ctx, cfg, usingSubscription);
          const usageLine = usageStatusLine ? theme.fg("dim", usageStatusLine) : undefined;

          let statsLeft = parts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const modelName = ctx.model?.id || "no-model";
          const thinkingLevel = pi.getThinkingLevel();
          const fastSuffix =
            fastController.active && supportsFast(ctx, cfg.supportedModels) ? " fast" : "";
          let rightWithoutProvider = modelName;
          if (ctx.model?.reasoning) {
            rightWithoutProvider =
              thinkingLevel === "off"
                ? `${modelName}${fastSuffix} • thinking off`
                : `${modelName}${fastSuffix} • ${thinkingLevel}`;
          } else if (fastSuffix) {
            rightWithoutProvider = `${modelName}${fastSuffix}`;
          }

          let rightSide = rightWithoutProvider;
          if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && ctx.model) {
            const withProvider = `(${ctx.model.provider}) ${rightWithoutProvider}`;
            if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
          }

          const rightWidth = visibleWidth(rightSide);
          const totalNeeded = statsLeftWidth + 2 + rightWidth;
          let statsLine: string;
          if (totalNeeded <= width) {
            statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - 2;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
              statsLine =
                statsLeft +
                " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) +
                truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const textLines: string[] = [
            truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
            theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)),
          ];
          if (usageLine) {
            textLines.push(truncateToWidth(usageLine, width, theme.fg("dim", "...")));
          }
          const extensionStatuses = footerData.getExtensionStatuses?.();
          if (extensionStatuses?.size) {
            const statusLines = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => String(a).localeCompare(String(b)))
              .map(([, text]) => theme.fg("dim", sanitizeStatusText(String(text))));
            textLines.push(
              ...statusLines.map((line) => truncateToWidth(line, width, theme.fg("dim", "..."))),
            );
          }
          return textLines;
        },
      };
    });
  }

  function clearFooter(ctx: ExtensionContext): void {
    if (!footerInstalled) return;
    ctx.ui.setFooter(undefined);
    footerInstalled = false;
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (!text && !statusInstalled) return;
    ctx.ui.setStatus(STATUS_KEY, text);
    statusInstalled = text !== undefined;
  }

  function setStatusWidget(ctx: ExtensionContext, text: string | undefined): void {
    if (!text && !statusWidgetInstalled) return;
    ctx.ui.setWidget(
      STATUS_KEY,
      text
        ? (_tui, theme) => ({
            invalidate() {},
            render(width: number): string[] {
              const line = theme.fg("dim", sanitizeStatusText(text));
              return [truncateToWidth(line, width, theme.fg("dim", "..."))];
            },
          })
        : undefined,
      { placement: "belowEditor" },
    );
    statusWidgetInstalled = text !== undefined;
  }

  function updateFooter(ctx: ExtensionContext): void {
    const cfg = config(ctx);

    if (!hasTerminalUI(ctx)) {
      if (cfg.footer.mode === "off") {
        setStatus(ctx, undefined);
        return;
      }
      const fast = fastController.statusSegment(ctx, cfg);
      const usage = usageController.statusLine(ctx, cfg);
      setStatus(ctx, [fast, usage].filter(Boolean).join(" | ") || undefined);
      return;
    }

    if (cfg.footer.mode === "replace") {
      setStatus(ctx, undefined);
      setStatusWidget(ctx, undefined);
      installFooter(ctx);
      return;
    }

    clearFooter(ctx);
    setStatus(ctx, undefined);

    if (cfg.footer.mode === "off") {
      setStatusWidget(ctx, undefined);
      return;
    }

    const fast = fastController.statusSegment(ctx, cfg);
    const usage = usageController.statusLine(ctx, cfg);
    setStatusWidget(ctx, [fast, usage].filter(Boolean).join(" | ") || undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    invalidateContextUsage();
    invalidateSessionName();
    const nextConfig = refresh(ctx);
    fastController.initializeForSession(ctx, nextConfig, pi.getFlag(FLAG) === true);
    if (
      fastController.desiredActive !== nextConfig.desiredActive ||
      fastController.active !== nextConfig.active
    ) {
      persist(nextConfig);
    }
    if (fastController.desiredActive && !fastController.active) {
      ctx.ui.notify(fastController.unsupportedRequestMessage(ctx, nextConfig), "warning");
    }
    refreshFooterTotals(ctx);
    updateFooter(ctx);
    usageController.start(ctx);
    if (fastController.active) ctx.ui.notify(fastController.stateText(nextConfig), "info");
  });

  pi.on("agent_start", (_event, ctx) => {
    invalidateContextUsage();
    updateFooter(ctx);
  });

  pi.on("turn_end", (event, ctx) => {
    invalidateContextUsage();
    if (event.message?.role === "assistant") {
      footerTotals.input += event.message.usage.input;
      footerTotals.output += event.message.usage.output;
      footerTotals.cacheRead += event.message.usage.cacheRead;
      footerTotals.cacheWrite += event.message.usage.cacheWrite;
      footerTotals.cost += event.message.usage.cost.total;
    } else {
      refreshFooterTotals(ctx);
    }
    updateFooter(ctx);
    void usageController.refresh(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    invalidateContextUsage();
    refreshFooterTotals(ctx);
    updateFooter(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    invalidateContextUsage();
    refreshFooterTotals(ctx);
    updateFooter(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    invalidateContextUsage();
    const cfg = config(ctx);
    const wasActive = fastController.active;
    fastController.applyDesiredState(ctx, cfg);
    if (fastController.active !== wasActive) {
      persist(cfg);
      ctx.ui.notify(
        fastController.active
          ? fastController.stateText(cfg)
          : fastController.inactiveForModelMessage(ctx),
        fastController.active ? "info" : "warning",
      );
    }
    updateFooter(ctx);
    void usageController.refresh(ctx, { force: true });
  });

  pi.on("session_shutdown", () => {
    invalidateContextUsage();
    invalidateSessionName();
    usageController.shutdown();
  });

  pi.on("before_provider_request", (event, ctx) => {
    return fastController.injectProviderPayload(event, ctx, config(ctx));
  });

  pi.on("message_start", invalidateContextUsage);
  pi.on("message_update", invalidateContextUsage);
  pi.on("message_end", invalidateContextUsage);
}

export const _test = {
  CONFIG_BASENAME,
  STATUS_KEY,
  DEFAULT_SUPPORTED_MODELS,
  DEFAULT_CONFIG,
  configPaths,
  abbreviateHomePath,
  parseModelKey,
  parseModels,
  normalizeModelKeys,
  resolveConfig,
  readRawConfig,
  supportsFast,
  modelList,
  currentModelKey,
  isGrokSubscriptionModel,
  parseUsageSnapshot,
  formatPercent,
  formatResetCountdown,
  formatUsageSnapshot,
  formatUsageDetail,
  readPiStoredOAuthToken,
  readGrokCliToken,
  XAI_PROVIDER_IDS,
  UsageController,
  FastController,
};
