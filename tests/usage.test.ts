import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatResetCountdown,
  formatUsageDetail,
  formatUsageSnapshot,
  parseUsageSnapshot,
  periodTypeLabel,
} from "../src/usage.ts";

const NOW = Date.parse("2026-08-27T12:00:00Z");

const weeklyCreditsPayload = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-25T17:34:08.027054+00:00",
      end: "2026-09-01T17:34:08.027054+00:00",
    },
    creditUsagePercent: 34,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [{ product: "GrokBuild", usagePercent: 34 }],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
    billingPeriodStart: "2026-08-25T17:34:08.027054+00:00",
    billingPeriodEnd: "2026-09-01T17:34:08.027054+00:00",
  },
};

const monthlyPayload = {
  config: {
    monthlyLimit: { val: 0 },
    used: { val: 0 },
    billingPeriodStart: "2026-08-01T00:00:00+00:00",
    billingPeriodEnd: "2026-09-01T00:00:00+00:00",
    history: [
      {
        billingCycle: { year: 2026, month: 7 },
        includedUsed: { val: 0 },
        onDemandUsed: { val: 0 },
        totalUsed: { val: 0 },
      },
    ],
  },
};

describe("parseUsageSnapshot", () => {
  it("parses the live weekly credits payload", () => {
    const snapshot = parseUsageSnapshot(weeklyCreditsPayload, NOW);
    expect(snapshot.creditUsagePercent).toBe(34);
    expect(snapshot.periodType).toBe("USAGE_PERIOD_TYPE_WEEKLY");
    expect(snapshot.periodEnd).toBe("2026-09-01T17:34:08.027054+00:00");
    expect(snapshot.isUnifiedBillingUser).toBe(true);
    expect(snapshot.productUsage).toEqual([{ product: "GrokBuild", usagePercent: 34 }]);
  });

  it("parses the monthly billing payload cents", () => {
    const snapshot = parseUsageSnapshot(monthlyPayload, NOW);
    expect(snapshot.usedCents).toBe(0);
    expect(snapshot.monthlyLimitCents).toBe(0);
    expect(snapshot.creditUsagePercent).toBeNull();
    expect(snapshot.periodEnd).toBe("2026-09-01T00:00:00+00:00");
  });

  it("returns null fields for missing config", () => {
    const snapshot = parseUsageSnapshot({}, NOW);
    expect(snapshot.creditUsagePercent).toBeNull();
    expect(snapshot.productUsage).toEqual([]);
  });

  it("throws on non-object payloads", () => {
    expect(() => parseUsageSnapshot("nope", NOW)).toThrow();
    expect(() => parseUsageSnapshot(null, NOW)).toThrow();
  });

  it("clamps and rejects bad percent values", () => {
    const snapshot = parseUsageSnapshot({ config: { creditUsagePercent: 140 } }, NOW);
    expect(snapshot.creditUsagePercent).toBeNull();
  });
});

describe("formatters", () => {
  it("formats left percent as 100 minus used", () => {
    expect(formatPercent(66)).toBe("66%");
    expect(formatPercent(null)).toBe("--");
  });

  it("formats reset countdowns", () => {
    expect(formatResetCountdown(5 * 86_400 + 2 * 3_600)).toBe("5d2h");
    expect(formatResetCountdown(3_600)).toBe("1h0m");
    expect(formatResetCountdown(125)).toBe("2m");
    expect(formatResetCountdown(45)).toBe("45s");
    expect(formatResetCountdown(null)).toBeNull();
  });

  it("maps period types to friendly labels", () => {
    expect(periodTypeLabel("USAGE_PERIOD_TYPE_WEEKLY")).toBe("weekly");
    expect(periodTypeLabel(null)).toBe("period");
  });

  it("renders the footer usage line with reset info", () => {
    const snapshot = parseUsageSnapshot(weeklyCreditsPayload, NOW);
    const line = formatUsageSnapshot(snapshot, { showResetTimes: true }, NOW);
    expect(line).toContain("Usage: 66% left");
    expect(line).toContain("↺");
  });

  it("renders the footer usage line without reset info", () => {
    const snapshot = parseUsageSnapshot(weeklyCreditsPayload, NOW);
    expect(formatUsageSnapshot(snapshot, { showResetTimes: false }, NOW)).toBe("Usage: 66% left");
  });

  it("renders detail lines including product usage", () => {
    const snapshot = parseUsageSnapshot(weeklyCreditsPayload, NOW);
    const detail = formatUsageDetail(snapshot);
    expect(detail).toContain("GrokBuild: 34% used");
    expect(detail).toContain("34% used · 66% left");
  });

  it("handles a fully used budget", () => {
    const snapshot = parseUsageSnapshot({ config: { creditUsagePercent: 100 } }, NOW);
    expect(formatUsageSnapshot(snapshot, { showResetTimes: false }, NOW)).toBe("Usage: 0% left");
  });
});
