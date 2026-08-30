import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.ts";
import { isXaiProvider, readPiStoredOAuthToken } from "./grok-auth.ts";
import { sanitizeDiagnosticError } from "./format.ts";
import { currentModelKey } from "./fast-controller.ts";
import { formatUsageDetail, formatUsageSnapshot, type UsageSnapshot } from "./usage.ts";

export function isGrokSubscriptionModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  cfg: ResolvedConfig,
  isUsingOAuth?: boolean,
): boolean {
  const model = ctx.model;
  if (!model) return false;
  const provider = String(model.provider ?? "");
  const idLooksGrok = String(model.id ?? "")
    .toLowerCase()
    .startsWith("grok-");
  if (!isXaiProvider(provider) && provider !== "grok-build" && !idLooksGrok) return false;
  if (!cfg.usage.showOnlyOnSubscriptionModels) return true;
  if (isUsingOAuth !== undefined) return isUsingOAuth;
  const registry = (ctx as { modelRegistry?: { isUsingOAuth?: (model: unknown) => boolean } })
    .modelRegistry;
  if (registry && typeof registry.isUsingOAuth === "function") {
    try {
      return registry.isUsingOAuth(model) === true;
    } catch {
      return false;
    }
  }
  return false;
}

const STALE_EXTENSION_CONTEXT_MESSAGE = "This extension ctx is stale";

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_EXTENSION_CONTEXT_MESSAGE);
}

type UsageRefreshOptions = { notify?: boolean; force?: boolean };

type QueuedUsageRefresh = {
  ctx: ExtensionContext;
  notify: boolean;
  force: boolean;
};

export type FetchUsageSnapshot = (ctx: ExtensionContext) => Promise<UsageSnapshot>;

export class UsageController {
  private usageSnapshot: UsageSnapshot | undefined;
  private usageUpdatedAt: number | undefined;
  private usageError: string | undefined;
  private usageLastFetchAt: number | undefined;
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  private usageRefreshInFlight = false;
  private queuedUsageRefresh: QueuedUsageRefresh | undefined;
  private shuttingDown = false;
  private readonly getConfig: (ctx: ExtensionContext) => ResolvedConfig;
  private readonly updateFooter: (ctx: ExtensionContext) => void;
  private readonly fetchSnapshot: FetchUsageSnapshot;

  constructor(
    getConfig: (ctx: ExtensionContext) => ResolvedConfig,
    updateFooter: (ctx: ExtensionContext) => void,
    fetchSnapshot: FetchUsageSnapshot,
  ) {
    this.getConfig = getConfig;
    this.updateFooter = updateFooter;
    this.fetchSnapshot = fetchSnapshot;
  }

  get snapshot(): UsageSnapshot | undefined {
    return this.usageSnapshot;
  }

  statusLine(
    ctx: ExtensionContext,
    cfg = this.getConfig(ctx),
    isUsingOAuth?: boolean,
  ): string | undefined {
    return this.usageSnapshot &&
      !this.usageError &&
      cfg.usage.enabled &&
      isGrokSubscriptionModel(ctx, cfg, isUsingOAuth)
      ? formatUsageSnapshot(this.usageSnapshot, cfg.usage)
      : undefined;
  }

  formatStatus(ctx: ExtensionContext): string {
    const cfg = this.getConfig(ctx);
    if (!cfg.usage.enabled) return "Usage display is disabled.";
    if (!isGrokSubscriptionModel(ctx, cfg)) {
      return "Usage hidden: current model is not an xAI subscription model.";
    }
    if (this.usageError) return `Usage unavailable: ${this.usageError}`;
    if (!this.usageSnapshot) return "Usage unavailable.";
    const stale =
      this.usageUpdatedAt && Date.now() - this.usageUpdatedAt > cfg.usage.refreshIntervalMs * 2
        ? ` · stale`
        : "";
    return `${formatUsageSnapshot(this.usageSnapshot, cfg.usage)}${stale}`;
  }

  formatDetail(ctx: ExtensionContext): string {
    if (!this.usageSnapshot) return this.formatStatus(ctx);
    return formatUsageDetail(this.usageSnapshot);
  }

  formatDebug(ctx: ExtensionContext): string {
    const cfg = this.getConfig(ctx);
    const credential = readPiStoredOAuthToken() ? "auth file" : undefined;
    return [
      `Usage enabled: ${cfg.usage.enabled}`,
      `Current model: ${currentModelKey(ctx) ?? "none"}`,
      `Current model eligible: ${isGrokSubscriptionModel(ctx, cfg)}`,
      `Requires subscription model: ${cfg.usage.showOnlyOnSubscriptionModels}`,
      `Auth: ${credential ?? resolveSourceHint()}`,
      `Last fetch: ${this.usageLastFetchAt ? new Date(this.usageLastFetchAt).toLocaleTimeString() : "never"}`,
      `Last successful update: ${this.usageUpdatedAt ? new Date(this.usageUpdatedAt).toLocaleTimeString() : "never"}`,
      `Last error: ${this.usageError ?? "none"}`,
      `Config: ${cfg.configPath}`,
    ].join("\n");
  }

  start(ctx: ExtensionContext): void {
    this.stopTimer();
    this.shuttingDown = false;
    const intervalMs = this.getConfig(ctx).usage.refreshIntervalMs;
    this.usageTimer = setInterval(() => {
      void this.refresh(ctx).catch(() => undefined);
    }, intervalMs);
    this.usageTimer.unref?.();
    void this.refresh(ctx).catch(() => undefined);
  }

  restart(ctx: ExtensionContext): void {
    this.start(ctx);
  }

  async refresh(ctx: ExtensionContext, options: UsageRefreshOptions = {}): Promise<void> {
    if (this.shuttingDown) return;
    if (this.usageRefreshInFlight) {
      this.queuedUsageRefresh = {
        ctx,
        notify: (this.queuedUsageRefresh?.notify ?? false) || options.notify === true,
        force: (this.queuedUsageRefresh?.force ?? false) || options.force === true,
      };
      return;
    }
    this.usageRefreshInFlight = true;
    try {
      await this.doRefresh(ctx, options);
    } finally {
      this.usageRefreshInFlight = false;
      const queued = this.queuedUsageRefresh;
      this.queuedUsageRefresh = undefined;
      if (queued && !this.shuttingDown) {
        await this.refresh(queued.ctx, { notify: queued.notify, force: queued.force }).catch(
          () => undefined,
        );
      }
    }
  }

  private async doRefresh(ctx: ExtensionContext, options: UsageRefreshOptions): Promise<void> {
    const cfg = this.getConfig(ctx);
    if (!isGrokSubscriptionModel(ctx, cfg)) {
      if (options.notify) {
        ctx.ui.notify("Usage hidden: current model is not an xAI subscription model.", "info");
      }
      return;
    }
    try {
      const snapshot = await this.fetchSnapshot(ctx);
      this.usageSnapshot = snapshot;
      this.usageUpdatedAt = Date.now();
      this.usageLastFetchAt = this.usageUpdatedAt;
      this.usageError = undefined;
      this.updateFooter(ctx);
      if (options.notify) ctx.ui.notify(this.formatStatus(ctx), "info");
    } catch (error) {
      if (isStaleExtensionContextError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.usageError = sanitizeDiagnosticError(message);
      this.usageLastFetchAt = Date.now();
      this.updateFooter(ctx);
      if (options.notify) {
        ctx.ui.notify(`Grok usage unavailable: ${this.usageError}`, "warning");
      }
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.stopTimer();
    this.queuedUsageRefresh = undefined;
  }

  private stopTimer(): void {
    if (this.usageTimer !== undefined) {
      clearInterval(this.usageTimer);
      this.usageTimer = undefined;
    }
  }
}

function resolveSourceHint(): string {
  return "missing (run /login xai)";
}
