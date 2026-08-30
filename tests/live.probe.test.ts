import { describe, expect, it } from "vitest";
import { resolveGrokCredential } from "../src/grok-auth.ts";
import { maskIdentifier } from "../src/format.ts";
import { formatUsageDetail, formatUsageSnapshot, requestGrokUsage } from "../src/usage.ts";

// Runs only when GROK_LIVE=1. Uses the real pi auth store (~/.pi/agent/auth.json,
// `xai` key) without ever printing token contents; account IDs are masked.
const RUN = process.env.GROK_LIVE === "1";

describe.skipIf(!RUN)("live xAI subscription surface (GROK_LIVE=1)", () => {
  it("resolves the pi-managed xAI OAuth credential", async () => {
    const credential = await resolveGrokCredential({
      model: undefined,
      modelRegistry: undefined,
    } as never);
    expect(credential).not.toBeNull();
    expect(credential!.token.length).toBeGreaterThan(20);
  });

  it("fetches and formats the real billing snapshot", async () => {
    const credential = await resolveGrokCredential({
      model: undefined,
      modelRegistry: undefined,
    } as never);
    expect(credential).not.toBeNull();
    const { userId, snapshot } = await requestGrokUsage(credential!);
    expect(userId.length).toBeGreaterThan(0);
    expect(snapshot.creditUsagePercent).toBeGreaterThanOrEqual(0);
    expect(snapshot.creditUsagePercent).toBeLessThanOrEqual(100);
    expect(snapshot.periodEnd).toBeTruthy();
    const footer = formatUsageSnapshot(snapshot, { showResetTimes: true });
    expect(footer.startsWith("Usage: ")).toBe(true);
    console.log(`userId(masked): ${maskIdentifier(userId)}`);
    console.log(`footer: ${footer}`);
    console.log(`detail:\n${formatUsageDetail(snapshot)}`);
  });
});
