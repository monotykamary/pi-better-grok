import { maskIdentifier } from "./format.ts";
import {
  resolveGrokCredential,
  type GrokCredential,
  type GrokCredentialContext,
} from "./grok-auth.ts";
import { formatPercent, type UsageSnapshot } from "./usage.ts";

// SuperGrok banked rate-limit resets. The inventory and redeem calls ride the
// grok.com consumer billing gRPC-Web service that the web usage page itself
// calls, authenticated with the same xAI OAuth token the usage meter uses.
// This is an undocumented surface: request shapes are pinned here and schema
// drift is expected — treat responses defensively and re-validate everything.
export const GROK_REMAINING_RESETS_URL =
  "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets";
export const GROK_REDEEM_RESET_URL = "https://grok.com/prod_mc_billing.ConsumerUiSvc/RedeemReset";

// Why: the billing RPC accepts the CLI token with only gRPC-Web framing; browser
// identity headers add no authorization (same pattern as the usage surface).
export const GROK_CLI_AUTH_HEADER = "xai-grok-cli";
export const GRPC_WEB_CONTENT_TYPE = "application/grpc-web+proto";

const LIST_TIMEOUT_MS = 10_000;
const REDEEM_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_ID_LENGTH = 128;
const MAX_TOKENS = 64;

export type GrokResetToken = {
  tokenId: string;
  grantedAtMs: number | null;
  expiresAtMs: number | null;
};

export type GrokResetCredits = {
  availableCount: number;
  nextExpiresAtMs: number | null;
  tokens: GrokResetToken[];
};

export type GrokRedeemCode = "reset" | "no_credit" | "already_redeemed";

export type GrokRedeemResult = { code: GrokRedeemCode };

export type ResetErrorCode =
  | "auth"
  | "challenge"
  | "http"
  | "grpc"
  | "invalid"
  | "oversize"
  | "transport";

export class ResetError extends Error {
  readonly code: ResetErrorCode;
  readonly status?: number;
  readonly grpcStatus?: string;

  constructor(code: ResetErrorCode, message: string, status?: number, grpcStatus?: string) {
    super(message);
    this.name = "ResetError";
    this.code = code;
    this.status = status;
    this.grpcStatus = grpcStatus;
  }
}

export const EMPTY_RESET_CREDITS: GrokResetCredits = {
  availableCount: 0,
  nextExpiresAtMs: null,
  tokens: [],
};

// gRPC-Web protobuf codec. Field numbers follow grok.com's public consumer_ui
// descriptor: ConsumerRedeemResetReq.token_id is field 10, remaining-reset
// responses carry repeated token messages on field 10 with inner fields
// 10 (token_id string), 20 (granted_at Timestamp), 30 (expires_at Timestamp).
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeVarint(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isFinite(value) || value < 0)
    throw new ResetError("invalid", "Varint must be a non-negative finite number.");
  let n = Math.floor(value);
  const bytes: number[] = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Uint8Array.from(bytes);
}

function encodeKey(field: number, wireType: number): Uint8Array<ArrayBuffer> {
  return encodeVarint((field << 3) | wireType);
}

function concatBytes(parts: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function encodeLengthDelimited(
  field: number,
  data: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  return concatBytes([encodeKey(field, 2), encodeVarint(data.byteLength), data]);
}

export function encodeStringField(field: number, value: string): Uint8Array<ArrayBuffer> {
  return encodeLengthDelimited(field, textEncoder.encode(value));
}

export function encodeRedeemResetRequest(tokenId: string): Uint8Array<ArrayBuffer> {
  return encodeStringField(10, tokenId);
}

function encodeGrpcWebFrame(
  flags: number,
  payload: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(5);
  header[0] = flags;
  header[1] = (payload.byteLength >>> 24) & 0xff;
  header[2] = (payload.byteLength >>> 16) & 0xff;
  header[3] = (payload.byteLength >>> 8) & 0xff;
  header[4] = payload.byteLength & 0xff;
  return concatBytes([header, payload]);
}

// Why: grok.com accepts a data frame only on the request; trailers are a
// response convention.
export function encodeGrpcWebRequest(
  payload: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  return encodeGrpcWebFrame(0, payload);
}

export type GrpcWebResponse = {
  payload: Uint8Array;
  grpcStatus: string;
  grpcMessage: string | null;
};

function decodeVarint(buf: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = start;
  while (i < buf.byteLength) {
    const byte = buf[i++];
    if (byte === undefined) break;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 35)
      throw new ResetError("invalid", "Grok reset response contained an oversized varint.");
  }
  throw new ResetError("invalid", "Grok reset response contained a truncated varint.");
}

type ProtoField =
  | { field: number; wireType: 0; value: number }
  | { field: number; wireType: 2; value: Uint8Array };

function decodeFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.byteLength) {
    const key = decodeVarint(buf, i);
    i = key.next;
    const field = key.value >>> 3;
    const wireType = key.value & 7;
    if (wireType === 0) {
      const varint = decodeVarint(buf, i);
      i = varint.next;
      fields.push({ field, wireType: 0, value: varint.value });
    } else if (wireType === 2) {
      const length = decodeVarint(buf, i);
      i = length.next;
      const end = i + length.value;
      if (end > buf.byteLength)
        throw new ResetError("invalid", "Grok reset response contained a truncated field.");
      fields.push({ field, wireType: 2, value: buf.subarray(i, end) });
      i = end;
    } else if (wireType === 1) {
      if (i + 8 > buf.byteLength)
        throw new ResetError("invalid", "Grok reset response contained a truncated fixed64 field.");
      i += 8;
    } else if (wireType === 5) {
      if (i + 4 > buf.byteLength)
        throw new ResetError("invalid", "Grok reset response contained a truncated fixed32 field.");
      i += 4;
    } else {
      throw new ResetError(
        "invalid",
        `Grok reset response used an unsupported wire type (${wireType}).`,
      );
    }
  }
  return fields;
}

function decodeTimestampMs(data: Uint8Array): number | null {
  const seconds = decodeFields(data).find((entry) => entry.field === 1 && entry.wireType === 0);
  if (!seconds || seconds.wireType !== 0) return null;
  return seconds.value * 1000;
}

export function decodeRemainingResetTokens(payload: Uint8Array): GrokResetToken[] {
  const tokens: GrokResetToken[] = [];
  for (const entry of decodeFields(payload)) {
    if (entry.field !== 10 || entry.wireType !== 2) continue;
    let tokenId: string | null = null;
    let grantedAtMs: number | null = null;
    let expiresAtMs: number | null = null;
    for (const inner of decodeFields(entry.value)) {
      if (inner.field === 10 && inner.wireType === 2) tokenId = textDecoder.decode(inner.value);
      else if (inner.field === 20 && inner.wireType === 2)
        grantedAtMs = decodeTimestampMs(inner.value);
      else if (inner.field === 30 && inner.wireType === 2)
        expiresAtMs = decodeTimestampMs(inner.value);
    }
    if (tokenId) tokens.push({ tokenId, grantedAtMs, expiresAtMs });
  }
  return tokens;
}

function parseTrailerBlock(text: string): { status: string | null; message: string | null } {
  let status: string | null = null;
  let message: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "grpc-status") status = value;
    else if (key === "grpc-message") {
      try {
        message = decodeURIComponent(value);
      } catch {
        message = value;
      }
    }
  }
  return { status, message };
}

export function decodeGrpcWebResponse(
  raw: Uint8Array,
  headerStatus?: string | null,
  headerMessage?: string | null,
): GrpcWebResponse {
  let payload: Uint8Array = new Uint8Array(0);
  let trailerStatus: string | null = null;
  let trailerMessage: string | null = null;
  let i = 0;
  while (i < raw.byteLength) {
    if (raw.byteLength - i < 5)
      throw new ResetError("invalid", "Grok reset response had a truncated gRPC-Web frame header.");
    const flags = raw[i]!;

    const length =
      raw[i + 1]! * 0x1000000 + raw[i + 2]! * 0x10000 + raw[i + 3]! * 0x100 + raw[i + 4]!;
    i += 5;
    const end = i + length;
    if (end > raw.byteLength)
      throw new ResetError(
        "invalid",
        "Grok reset response had a truncated gRPC-Web frame payload.",
      );
    const chunk = raw.subarray(i, end);
    i = end;
    if (flags & 0x80) {
      const parsed = parseTrailerBlock(textDecoder.decode(chunk));
      trailerStatus = parsed.status;
      trailerMessage = parsed.message;
      break;
    }
    payload = chunk;
  }
  const grpcStatus = trailerStatus ?? headerStatus;
  if (grpcStatus == null)
    throw new ResetError("invalid", "Grok reset response was missing grpc-status.");
  return { payload, grpcStatus, grpcMessage: trailerMessage ?? headerMessage ?? null };
}

function isPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function sanitizeTokenId(value: string): string | null {
  return value && value.length <= MAX_TOKEN_ID_LENGTH && isPrintableAscii(value) ? value : null;
}

export function summarizeResetTokens(tokens: readonly GrokResetToken[]): GrokResetCredits {
  const sanitized = tokens
    .map((token) => {
      const tokenId = sanitizeTokenId(token.tokenId);
      return tokenId ? { ...token, tokenId } : undefined;
    })
    .filter((token): token is GrokResetToken => token !== undefined)
    .slice(0, MAX_TOKENS);
  const expiries = sanitized
    .map((token) => token.expiresAtMs)
    .filter((expiresAtMs): expiresAtMs is number => typeof expiresAtMs === "number")
    .sort((left, right) => left - right);
  return {
    availableCount: sanitized.length,
    nextExpiresAtMs: expiries[0] ?? null,
    tokens: sanitized,
  };
}

// Soonest-expiring token first: banked resets expire, so spend the one closest
// to expiry. Tokens without an expiry sort last.
export function selectGrokResetToken(
  tokens: readonly GrokResetToken[],
): GrokResetToken | undefined {
  return [...tokens].sort((left, right) => {
    const leftExpiry = left.expiresAtMs ?? Number.POSITIVE_INFINITY;
    const rightExpiry = right.expiresAtMs ?? Number.POSITIVE_INFINITY;
    if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
    return (left.grantedAtMs ?? 0) - (right.grantedAtMs ?? 0);
  })[0];
}

// Redeem outcome mapping, pinned to grok.com's observed grpc-status codes:
// 0 = reset applied; 9 (FAILED_PRECONDITION-ish) = already redeemed when the
// message says so, otherwise no credit; 3 (INVALID_ARGUMENT) naming token_id
// means the token was unknown or spent. Everything else is a hard failure.
export function mapGrokRedeemStatus(
  grpcStatus: string,
  grpcMessage: string | null,
): GrokRedeemResult {
  if (grpcStatus === "0") return { code: "reset" };
  const message = (grpcMessage ?? "").toLowerCase();
  if (grpcStatus === "9") {
    return message.includes("redeem") && message.includes("already")
      ? { code: "already_redeemed" }
      : { code: "no_credit" };
  }
  if (grpcStatus === "3" && message.includes("token_id")) return { code: "no_credit" };
  throw new ResetError(
    "grpc",
    grpcMessage
      ? `Grok reset failed: ${grpcMessage}`
      : `Grok reset failed (grpc-status ${grpcStatus})`,
    undefined,
    grpcStatus,
  );
}

function resetHeaders(credential: GrokCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.token}`,
    "X-XAI-Token-Auth": GROK_CLI_AUTH_HEADER,
    "Content-Type": GRPC_WEB_CONTENT_TYPE,
    "x-grpc-web": "1",
  };
}

async function postGrokRpc(
  url: string,
  credential: GrokCredential,
  payload: Uint8Array,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<GrpcWebResponse> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: resetHeaders(credential),
      body: encodeGrpcWebRequest(payload),
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResetError("transport", `Grok reset request failed: ${message}`);
  }
  if (!response.ok) {
    if (response.headers.get("cf-mitigated") === "challenge") {
      throw new ResetError(
        "challenge",
        `grok.com is serving a Cloudflare browser challenge (HTTP ${response.status}); banked reset data cannot be fetched from a non-browser client.`,
        response.status,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ResetError(
        "auth",
        `xAI reset request was unauthorized (HTTP ${response.status}). Run /login xai and try again.`,
        response.status,
      );
    }
    throw new ResetError(
      "http",
      `Grok reset request failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.byteLength > MAX_RESPONSE_BYTES) {
    throw new ResetError("oversize", "Grok reset response exceeded the size limit.");
  }
  return decodeGrpcWebResponse(
    raw,
    response.headers.get("grpc-status"),
    response.headers.get("grpc-message"),
  );
}

export async function fetchGrokResetCredits(
  credential: GrokCredential,
  options: { signal?: AbortSignal } = {},
): Promise<GrokResetCredits> {
  if (!credential.token) {
    throw new ResetError("auth", "xAI OAuth credentials are required. Run /login xai first.");
  }
  const response = await postGrokRpc(GROK_REMAINING_RESETS_URL, credential, new Uint8Array(), {
    signal: options.signal,
    timeoutMs: LIST_TIMEOUT_MS,
  });
  if (response.grpcStatus === "16") {
    throw new ResetError(
      "auth",
      response.grpcMessage
        ? `xAI reset-token inventory rejected the credential: ${response.grpcMessage}`
        : "xAI reset-token inventory rejected the credential. Run /login xai and try again.",
      undefined,
      response.grpcStatus,
    );
  }
  // Accounts without the SuperGrok reset entitlement answer with a non-OK grpc
  // status instead of an empty inventory; treat that as zero so /grok-resets
  // still opens. Redeem re-validates server-side, so this can never over-count.
  if (response.grpcStatus !== "0") return EMPTY_RESET_CREDITS;
  return summarizeResetTokens(decodeRemainingResetTokens(response.payload));
}

export async function redeemGrokReset(
  credential: GrokCredential,
  tokenId: string | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<GrokRedeemResult> {
  if (!credential.token) {
    throw new ResetError("auth", "xAI authentication is unavailable. Run /login xai first.");
  }
  let token = tokenId?.trim() ?? "";
  if (!token) {
    const credits = await fetchGrokResetCredits(credential, options);
    token = selectGrokResetToken(credits.tokens)?.tokenId ?? "";
  }
  if (!token) return { code: "no_credit" };
  const response = await postGrokRpc(
    GROK_REDEEM_RESET_URL,
    credential,
    encodeRedeemResetRequest(token),
    { signal: options.signal, timeoutMs: REDEEM_TIMEOUT_MS },
  );
  return mapGrokRedeemStatus(response.grpcStatus, response.grpcMessage);
}

export function decodeRedeemResetTokenId(payload: Uint8Array): string | null {
  for (const field of decodeFields(payload)) {
    if (field.field === 10 && field.wireType === 2) return textDecoder.decode(field.value);
  }
  return null;
}

export type GrokResetContext = GrokCredentialContext;

export async function requestGrokResetCredits(
  ctx: GrokResetContext,
  signal?: AbortSignal,
): Promise<GrokResetCredits | undefined> {
  const credential = await resolveGrokCredential(ctx);
  if (!credential) return undefined;
  return fetchGrokResetCredits(credential, { signal });
}

export async function redeemGrokResetForSession(
  ctx: GrokResetContext,
  tokenId: string | undefined,
  signal?: AbortSignal,
): Promise<GrokRedeemResult> {
  const credential = await resolveGrokCredential(ctx);
  if (!credential) {
    throw new ResetError("auth", "xAI authentication is unavailable. Run /login xai first.");
  }
  return redeemGrokReset(credential, tokenId, { signal });
}

function formatResetTimestamp(ms: number | null): string {
  if (ms === null) return "unknown";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatGrokResetChoice(token: GrokResetToken, index: number): string {
  const expires = `expires ${formatResetTimestamp(token.expiresAtMs)}`;
  return `${index + 1}. SuperGrok rate-limit reset (${maskIdentifier(token.tokenId)}) · ${expires}`;
}

export function formatGrokResetOutcome(result: GrokRedeemResult): {
  message: string;
  level: "info" | "warning";
} {
  switch (result.code) {
    case "reset":
      return {
        message: "Banked reset redeemed — your SuperGrok usage limit was restored.",
        level: "info",
      };
    case "no_credit":
      return { message: "No banked Grok resets remain available.", level: "warning" };
    case "already_redeemed":
      return { message: "That banked reset was already redeemed.", level: "warning" };
  }
}

export function buildGrokResetConfirmation(options: {
  token?: GrokResetToken;
  availableCount: number;
  snapshot?: Pick<UsageSnapshot, "creditUsagePercent">;
}): { title: string; message: string } {
  const token = options.token;
  const lines: string[] = ["SuperGrok rate-limit reset"];
  lines.push(`Token: ${token ? maskIdentifier(token.tokenId) : "auto-selected"}`);
  if (token?.grantedAtMs != null) lines.push(`Granted: ${formatResetTimestamp(token.grantedAtMs)}`);
  lines.push(`Expires: ${formatResetTimestamp(token?.expiresAtMs ?? null)}`);
  lines.push(`Available: ${options.availableCount}`);
  if (options.snapshot?.creditUsagePercent != null) {
    lines.push(`Current usage: weekly ${formatPercent(options.snapshot.creditUsagePercent)} used`);
  }
  lines.push("");
  lines.push(
    "This redeems one SuperGrok reset token, restores your weekly usage limit immediately, and cannot be undone.",
  );
  return { title: "Redeem banked Grok reset?", message: lines.join("\n") };
}
