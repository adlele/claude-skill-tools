import { describe, it, expect } from "vitest";
import { sleep } from "../../src/shared/utils.js";

describe("sleep", () => {
  it("resolves after the specified delay", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow small timing tolerance
  });

  it("returns a promise that resolves to undefined", async () => {
    const result = await sleep(1);
    expect(result).toBeUndefined();
  });
});
