import {
  truncateToWidth as truncateTerminalText,
  visibleWidth as terminalVisibleWidth,
} from "@earendil-works/pi-tui";

const ANSI_ESCAPE_PATTERN = String.raw`\u001B\[[0-?]*[ -/]*[@-~]`;
const ANSI_ESCAPE_REGEXP = new RegExp(ANSI_ESCAPE_PATTERN, "g");
const DIAGNOSTIC_MAX_LENGTH = 500;

function replaceControlCharacters(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    result += code <= 31 || (code >= 127 && code <= 159) ? " " : char;
  }
  return result;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEXP, "");
}

export function visibleWidth(value: string): number {
  return terminalVisibleWidth(value);
}

export function truncateToWidth(value: string, width: number, ellipsis = "..."): string {
  return truncateTerminalText(value, width, ellipsis);
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function sanitizeStatusText(text: string): string {
  return text.replace(/[ \r\n\t]+/g, " ").trim();
}

export function maskIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) return "found";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function sanitizeDiagnosticError(
  message: string,
  maxLength = DIAGNOSTIC_MAX_LENGTH,
): string {
  const redactedSecrets = stripAnsi(message)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(
      /(["']?(?:access|access_token|token|api[_-]?key|authorization|accountId|account_id|userId|user_id|refresh)["']?\s*[:=]\s*["']?)([^"',\s}\]]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\[REDACTED\](?:\])+/g, "[REDACTED]");
  const redacted = replaceControlCharacters(redactedSecrets).replace(/ +/g, " ").trim();
  const sanitized = redacted || "Unknown error.";
  if (sanitized.length <= maxLength) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
