import { describe, it, expect } from "vitest";
import { expandRanges } from "../../src/sandbox/ralph-helpers.js";

describe("expandRanges", () => {
  it("parses space-separated numbers", () => {
    expect(expandRanges("1 2 3")).toEqual([1, 2, 3]);
  });

  it("expands a range", () => {
    expect(expandRanges("1-5")).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles mixed numbers and ranges", () => {
    expect(expandRanges("1-3 7 10-12")).toEqual([1, 2, 3, 7, 10, 11, 12]);
  });

  it("returns empty array for empty string", () => {
    expect(expandRanges("")).toEqual([]);
  });

  it("returns empty array for non-numeric input", () => {
    expect(expandRanges("abc xyz")).toEqual([]);
  });

  it("handles single number", () => {
    expect(expandRanges("42")).toEqual([42]);
  });

  it("handles range of one", () => {
    expect(expandRanges("5-5")).toEqual([5]);
  });
});
