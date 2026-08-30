import { describe, expect, it } from "vitest";
import {
  formatTokens,
  maskIdentifier,
  sanitizeDiagnosticError,
  sanitizeStatusText,
  stripAnsi,
  truncateToWidth,
} from "../src/format.ts";

describe("maskIdentifier", () => {
  it("masks long identifiers and collapses short ones", () => {
    expect(maskIdentifier("abcd1234efgh5678")).toBe("abcd...5678");
    expect(maskIdentifier("short")).toBe("found");
    expect(maskIdentifier(undefined)).toBeUndefined();
  });
});

describe("sanitizeDiagnosticError", () => {
  it("redacts bearer tokens, api keys, and identity fields", () => {
    const message = "auth failed for Bearer abc.def.ghi with sk-secret12345678 userId=user-1234";
    const sanitized = sanitizeDiagnosticError(message);
    expect(sanitized).not.toContain("abc.def.ghi");
    expect(sanitized).toContain("Bearer [REDACTED]");
    expect(sanitized).toContain("sk-[REDACTED]");
    expect(sanitized).not.toContain("user-1234");
  });

  it("clamps long messages", () => {
    const sanitized = sanitizeDiagnosticError("x".repeat(2_000));
    expect(sanitized.length).toBeLessThanOrEqual(500);
    expect(sanitized.endsWith("…")).toBe(true);
  });
});

describe("formatTokens", () => {
  it("formats token counts", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("status helpers", () => {
  it("strips ANSI escapes and collapses status whitespace", () => {
    expect(stripAnsi("\u001B[31mred\u001B[0m")).toBe("red");
    expect(sanitizeStatusText("a\n b\t c")).toBe("a b c");
  });

  it("truncates to visible width", () => {
    expect(stripAnsi(truncateToWidth("hello world", 8))).toBe("hello...");
  });
});
