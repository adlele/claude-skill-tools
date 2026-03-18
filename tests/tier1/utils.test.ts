import { describe, it, expect } from "vitest";
import { nowISO } from "../../src/shared/utils.js";

describe("nowISO", () => {
  it("matches ISO 8601 format without milliseconds", () => {
    const result = nowISO();
    // Expected format: 2026-03-08T12:34:56Z
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("is within 1 second of actual time", () => {
    const before = Date.now();
    const result = nowISO();
    const after = Date.now();
    const parsed = new Date(result).getTime();
    // The result should be within 1 second of the window
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
  });

  it("does not contain milliseconds", () => {
    const result = nowISO();
    expect(result).not.toMatch(/\.\d{3}Z$/);
  });
});
