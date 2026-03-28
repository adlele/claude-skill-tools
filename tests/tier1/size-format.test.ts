import { describe, it, expect } from "vitest";
import { formatSizeKB } from "../../src/sandbox/size.js";

describe("formatSizeKB", () => {
  it("formats kilobytes", () => {
    expect(formatSizeKB(512)).toBe("512 KB");
  });

  it("formats megabytes", () => {
    expect(formatSizeKB(1_024)).toBe("1.0 MB");
    expect(formatSizeKB(350_000)).toBe("341.8 MB");
  });

  it("formats gigabytes", () => {
    expect(formatSizeKB(1_048_576)).toBe("1.0 GB");
    expect(formatSizeKB(2_500_000)).toBe("2.4 GB");
  });

  it("handles zero", () => {
    expect(formatSizeKB(0)).toBe("0 KB");
  });

  it("handles edge at MB boundary", () => {
    expect(formatSizeKB(1_023)).toBe("1023 KB");
    expect(formatSizeKB(1_024)).toBe("1.0 MB");
  });

  it("handles edge at GB boundary", () => {
    expect(formatSizeKB(1_048_575)).toBe("1024.0 MB");
    expect(formatSizeKB(1_048_576)).toBe("1.0 GB");
  });
});
