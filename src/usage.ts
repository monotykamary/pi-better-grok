import type { GrokCredential } from "./grok-auth.ts";

// Revision-pinned Grok subscription surface. Same unofficial contract used by
// pi-grok-usage and pi-xai /xai-usage: authenticated GET /v1/user, then
// GET /v1/billing?format=credits carrying the x-userid identity header.
export const XAI_CLI_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
export const XAI_CLI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export const GROK_CLIENT_IDENTIFIER = process.env.PI_XAI_CLIENT_NAME || "grok-shell";
export const GROK_CLIENT_VERSION = process.env.PI_XAI_CLIENT_VERSION || "0.2.101";

const USAGE_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CENTS = 1_000_000_000_000;
const MAX_USER_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 80;

export type ProductUsage = { product: string; usagePercent: number };

export type UsageSnapshot = {
  capturedAt: number;
  creditUsagePercent: number | null;
  periodType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  subscriptionTier: string | null;
  isUnifiedBillingUser: boolean | null;
  productUsage: ProductUsage[];
  usedCents: number | null;
  monthlyLimitCents: number | null;
  prepaidBalanceCents: number | null;
};

type UsageErrorCode = "auth" | "http" | "invalid" | "oversize" | "transport";

export class UsageError extends Error {
  readonly code: UsageErrorCode;
  readonly status?: number;

  constructor(code: UsageErrorCode, message: string, status?: number) {
    super(message);
    this.name = "UsageError";
    this.code = code;
    this.status = status;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function boundedPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function boundedCents(value: unknown): number | undefined {
  const wrapper = objectValue(value);
  if (!wrapper) return undefined;
  const cents = wrapper.val;
  return typeof cents === "number" &&
    Number.isSafeInteger(cents) &&
    cents >= 0 &&
    cents <= MAX_CENTS
    ? cents
    : undefined;
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label && label.length <= MAX_LABEL_LENGTH && !hasControlCharacters(label)
    ? label
    : undefined;
}

function boundedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = value.trim();
  if (!timestamp || timestamp.length > 64) return undefined;
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

function isPrintableAscii(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

export function parseUserId(value: unknown): string {
  const userId = objectValue(value)?.userId;
  if (
    typeof userId !== "string" ||
    !userId ||
    userId.length > MAX_USER_ID_LENGTH ||
    !isPrintableAscii(userId)
  ) {
    throw new UsageError(
      "invalid",
      "xAI account identity could not be verified; billing was not requested.",
    );
  }
  return userId;
}

export function parseUsageSnapshot(data: unknown, now = Date.now()): UsageSnapshot {
  const root = objectValue(data);
  if (!root) throw new UsageError("invalid", "xAI usage returned an invalid response.");
  const config = objectValue(root.config);
  const snapshot: UsageSnapshot = {
    capturedAt: now,
    creditUsagePercent: null,
    periodType: null,
    periodStart: null,
    periodEnd: null,
    subscriptionTier: null,
    isUnifiedBillingUser: null,
    productUsage: [],
    usedCents: null,
    monthlyLimitCents: null,
    prepaidBalanceCents: null,
  };
  if (!config) return snapshot;

  const percent = boundedPercent(config.creditUsagePercent);
  if (percent !== undefined) snapshot.creditUsagePercent = percent;

  const period = objectValue(config.currentPeriod);
  if (period) {
    snapshot.periodType = boundedLabel(period.type) ?? null;
    snapshot.periodStart = boundedTimestamp(period.start) ?? null;
    snapshot.periodEnd = boundedTimestamp(period.end) ?? null;
  }
  if (!snapshot.periodStart) {
    snapshot.periodStart = boundedTimestamp(config.billingPeriodStart) ?? null;
  }
  if (!snapshot.periodEnd) {
    snapshot.periodEnd = boundedTimestamp(config.billingPeriodEnd) ?? null;
  }

  snapshot.subscriptionTier = boundedLabel(root.subscriptionTier) ?? null;
  if (typeof config.isUnifiedBillingUser === "boolean") {
    snapshot.isUnifiedBillingUser = config.isUnifiedBillingUser;
  }

  if (Array.isArray(config.productUsage)) {
    for (const entry of config.productUsage.slice(0, 16)) {
      const record = objectValue(entry);
      if (!record) continue;
      const product = boundedLabel(record.product);
      const usagePercent = boundedPercent(record.usagePercent);
      if (product && usagePercent !== undefined) {
        snapshot.productUsage.push({ product, usagePercent });
      }
    }
  }

  const used = boundedCents(config.used);
  if (used !== undefined) snapshot.usedCents = used;
  const monthlyLimit = boundedCents(config.monthlyLimit);
  if (monthlyLimit !== undefined) snapshot.monthlyLimitCents = monthlyLimit;
  const prepaid = boundedCents(config.prepaidBalance);
  if (prepaid !== undefined) snapshot.prepaidBalanceCents = prepaid;

  return snapshot;
}

export function formatPercent(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(clampPercent(value))}%`
    : "--";
}

export function formatResetCountdown(seconds: number | null): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${secs}s`;
}

export function formatResetClock(seconds: number | null, now = Date.now()): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const reset = new Date(now + seconds * 1000);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    reset,
  );
  if (reset.toDateString() === new Date(now).toDateString()) return time;
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(reset);
  return `${weekday} ${time}`;
}

export function periodSecondsLeft(snapshot: UsageSnapshot, now = Date.now()): number | null {
  if (!snapshot.periodEnd) return null;
  const end = Date.parse(snapshot.periodEnd);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, (end - now) / 1000);
}

export function periodTypeLabel(periodType: string | null): string {
  if (!periodType) return "period";
  const prefix = "USAGE_PERIOD_TYPE_";
  const short = periodType.startsWith(prefix) ? periodType.slice(prefix.length) : periodType;
  return short.toLowerCase();
}

export function formatCents(cents: number | null): string {
  return typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "--";
}

export function formatUsageSnapshot(
  snapshot: UsageSnapshot,
  options: { showResetTimes: boolean },
  now = Date.now(),
): string {
  const used = snapshot.creditUsagePercent;
  const left = used === null ? null : clampPercent(100 - used);
  const parts = [`Grok: ${formatPercent(left)} left`];
  if (options.showResetTimes) {
    const seconds = periodSecondsLeft(snapshot, now);
    const countdown = formatResetCountdown(seconds);
    const clock = formatResetClock(seconds, now);
    if (countdown && clock) parts.push(`↺ ${countdown} - ${clock}`);
  }
  return parts.join(" · ");
}

export function formatUsageDetail(snapshot: UsageSnapshot): string {
  const lines: string[] = [];
  const used = snapshot.creditUsagePercent;
  const left = used === null ? null : clampPercent(100 - used);
  lines.push(`Included usage: ${formatPercent(used)} used · ${formatPercent(left)} left`);
  if (snapshot.periodStart && snapshot.periodEnd) {
    lines.push(
      `${periodTypeLabel(snapshot.periodType)} period: ${snapshot.periodStart} → ${snapshot.periodEnd}`,
    );
  }
  for (const entry of snapshot.productUsage) {
    lines.push(`${entry.product}: ${formatPercent(entry.usagePercent)} used`);
  }
  if (snapshot.subscriptionTier) lines.push(`Tier: ${snapshot.subscriptionTier}`);
  if (snapshot.usedCents !== null || snapshot.monthlyLimitCents !== null) {
    lines.push(
      `Monthly: ${formatCents(snapshot.usedCents)} of ${formatCents(snapshot.monthlyLimitCents)}`,
    );
  }
  if (snapshot.prepaidBalanceCents !== null && snapshot.prepaidBalanceCents > 0) {
    lines.push(`Prepaid balance: ${formatCents(snapshot.prepaidBalanceCents)}`);
  }
  lines.push(`Captured: ${new Date(snapshot.capturedAt).toLocaleTimeString()}`);
  return lines.join("\n");
}

export function usageHeaders(accessToken: string, userId?: string): Record<string, string> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLIENT_VERSION,
    "x-grok-client-mode": interactive ? "interactive" : "headless",
    ...(userId ? { "x-userid": userId } : {}),
  };
}

function httpError(status: number): UsageError {
  if (status === 401 || status === 403) {
    return new UsageError(
      "auth",
      "xAI authentication was rejected. Run /login xai and try again.",
      status,
    );
  }
  if (status === 429) {
    return new UsageError("http", "xAI usage is rate limited. Try again later.", status);
  }
  return new UsageError("http", `xAI usage request failed with status ${status}.`, status);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(USAGE_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: requestSignal(signal) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError("transport", `xAI usage request failed: ${message}`);
  }
  if (!response.ok) throw httpError(response.status);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new UsageError("oversize", "xAI usage returned an oversized response.");
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError("invalid", `xAI usage returned an invalid response body: ${message}`);
  }
}

export async function requestGrokUsage(
  credential: GrokCredential,
  options: { signal?: AbortSignal } = {},
): Promise<{ userId: string; snapshot: UsageSnapshot }> {
  if (!credential.token) {
    throw new UsageError("auth", "xAI OAuth credentials are required. Run /login xai first.");
  }
  const userPayload = await fetchJson(
    XAI_CLI_USER_URL,
    usageHeaders(credential.token),
    options.signal,
  );
  const userId = parseUserId(userPayload);
  const billingPayload = await fetchJson(
    XAI_CLI_BILLING_URL,
    usageHeaders(credential.token, userId),
    options.signal,
  );
  return { userId, snapshot: parseUsageSnapshot(billingPayload) };
}
