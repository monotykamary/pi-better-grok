import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig, SupportedModel } from "./config.ts";

export function currentModelKey(ctx: Pick<ExtensionContext, "model">): string | undefined {
  const model = ctx.model;
  if (!model?.provider || !model.id) return undefined;
  return `${model.provider}/${model.id}`;
}

export function modelList(models: SupportedModel[]): string {
  return models.map((model) => `${model.provider}/${model.id}`).join(", ");
}

export function supportsFast(
  ctx: Pick<ExtensionContext, "model">,
  supportedModels: SupportedModel[],
): boolean {
  const key = currentModelKey(ctx);
  return (
    key !== undefined && supportedModels.some((model) => `${model.provider}/${model.id}` === key)
  );
}

export class FastController {
  active = false;
  desiredActive = false;

  setDesired(ctx: Pick<ExtensionContext, "model">, config: ResolvedConfig, next: boolean): void {
    this.desiredActive = next;
    this.applyDesiredState(ctx, config);
  }

  applyDesiredState(ctx: Pick<ExtensionContext, "model">, config: ResolvedConfig): void {
    this.active = this.desiredActive && supportsFast(ctx, config.supportedModels);
  }

  initializeForSession(
    ctx: Pick<ExtensionContext, "model">,
    config: ResolvedConfig,
    flagEnabled: boolean,
  ): void {
    this.desiredActive = flagEnabled || (config.persistState ? config.desiredActive : false);
    this.applyDesiredState(ctx, config);
  }

  injectProviderPayload(
    event: { payload?: unknown },
    ctx: Pick<ExtensionContext, "model">,
    config: ResolvedConfig,
  ): Record<string, unknown> | undefined {
    if (!this.active || !supportsFast(ctx, config.supportedModels)) return undefined;
    if (!event?.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      return undefined;
    }
    return { ...(event.payload as Record<string, unknown>), reasoning_effort: config.fast.effort };
  }

  statusSegment(ctx: Pick<ExtensionContext, "model">, config: ResolvedConfig): string | undefined {
    return this.active && supportsFast(ctx, config.supportedModels) ? "fast" : undefined;
  }

  stateText(config: ResolvedConfig): string {
    return `Fast mode enabled (reasoning_effort=${config.fast.effort})`;
  }

  unsupportedRequestMessage(ctx: Pick<ExtensionContext, "model">, config: ResolvedConfig): string {
    return `Fast mode unavailable for ${currentModelKey(ctx) ?? "current model"}. Supported: ${modelList(config.supportedModels)}`;
  }

  inactiveForModelMessage(ctx: Pick<ExtensionContext, "model">): string {
    return `Fast mode inactive for ${currentModelKey(ctx) ?? "current model"}.`;
  }

  debugLines(ctx: Pick<ExtensionContext, "model">, config: ResolvedConfig): string[] {
    return [
      `Fast desired: ${this.desiredActive}`,
      `Fast active: ${this.active}`,
      `Fast eligible: ${supportsFast(ctx, config.supportedModels)}`,
      `Fast effort: ${config.fast.effort}`,
    ];
  }
}
