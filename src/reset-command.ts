import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticError } from "./format.ts";
import type { ResetController } from "./reset-controller.ts";
import {
  buildGrokResetConfirmation,
  formatGrokResetChoice,
  formatGrokResetOutcome,
  redeemGrokResetForSession,
  selectGrokResetToken,
} from "./resets.ts";
import type { UsageSnapshot } from "./usage.ts";

/** What the /grok-resets flow needs from the extension's session state. */
export type ResetCommandHost = {
  resetController: ResetController;
  usageSnapshot: () => UsageSnapshot | undefined;
  /** Refresh usage, banked resets and the footer after a redemption. */
  afterRedeem: (ctx: ExtensionContext) => void;
};

// Loaded by the /grok-resets handler on first use; index.ts keeps only the
// command registration.
export async function redeemBankedReset(
  ctx: ExtensionContext,
  host: ResetCommandHost,
): Promise<void> {
  const { resetController } = host;
  let credits = resetController.snapshot?.credits;
  if (!credits) {
    await resetController.refresh(ctx, { force: true }).catch(() => {});
    credits = resetController.snapshot?.credits;
  }
  if (!credits) {
    const reason = resetController.lastError;
    ctx.ui.notify(`Banked reset lookup failed${reason ? `: ${reason}` : "."}`, "error");
    return;
  }
  void resetController.refresh(ctx).catch(() => {});
  if (credits.availableCount <= 0) {
    ctx.ui.notify("No banked Grok resets are available for this account.", "info");
    return;
  }
  let selected = selectGrokResetToken(credits.tokens);
  if (credits.tokens.length > 1 && selected) {
    const options = credits.tokens.map((token, index) => formatGrokResetChoice(token, index));
    const chosen = await ctx.ui.select("Redeem which banked reset?", options);
    if (chosen === undefined) {
      ctx.ui.notify("Banked reset redemption cancelled.", "info");
      return;
    }
    selected = credits.tokens[Math.max(0, options.indexOf(chosen))];
  }
  const confirmation = buildGrokResetConfirmation({
    token: selected,
    availableCount: credits.availableCount,
    snapshot: host.usageSnapshot(),
  });
  if (!(await ctx.ui.confirm(confirmation.title, confirmation.message))) {
    ctx.ui.notify("Banked reset redemption cancelled.", "info");
    return;
  }
  try {
    const timeoutSignal = AbortSignal.timeout(30_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
    const result = await redeemGrokResetForSession(ctx, selected?.tokenId, signal);
    const outcome = formatGrokResetOutcome(result);
    ctx.ui.notify(outcome.message, outcome.level);
    host.afterRedeem(ctx);
  } catch (error) {
    ctx.ui.notify(
      `Banked reset redemption failed: ${sanitizeDiagnosticError(
        error instanceof Error ? error.message : String(error),
      )}`,
      "error",
    );
  }
}
