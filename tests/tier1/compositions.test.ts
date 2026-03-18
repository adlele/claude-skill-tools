import { describe, it, expect } from "vitest";
import { getAvailableCompositions } from "../../src/composer/commands.js";

describe("getAvailableCompositions", () => {
  it("returns all expected composition types", () => {
    const compositions = getAvailableCompositions();
    expect(compositions).toContain("full");
    expect(compositions).toContain("ralph-only");
    expect(compositions).toContain("manual");
    expect(compositions).toContain("role");
    expect(compositions).toContain("headless");
  });

  it("returns an array of strings", () => {
    const compositions = getAvailableCompositions();
    expect(Array.isArray(compositions)).toBe(true);
    for (const c of compositions) {
      expect(typeof c).toBe("string");
    }
  });
});
