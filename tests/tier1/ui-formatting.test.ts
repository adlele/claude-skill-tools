import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  formatElapsed,
  relativeTime,
  statusBadge,
} from "../../src/shared/ui.js";

describe("stripAnsi", () => {
  it("removes ANSI escape codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[39m")).toBe("red");
  });

  it("is a no-op on plain text", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips multiple ANSI codes", () => {
    expect(stripAnsi("\x1b[1m\x1b[31mbold red\x1b[39m\x1b[22m")).toBe(
      "bold red",
    );
  });
});

describe("formatElapsed", () => {
  it("formats sub-second as seconds with decimal", () => {
    expect(formatElapsed(500)).toBe("0.5s");
  });

  it("formats seconds", () => {
    expect(formatElapsed(45_000)).toBe("45.0s");
  });

  it("formats exactly one minute", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
  });

  it("formats multi-minute durations", () => {
    expect(formatElapsed(150_000)).toBe("2m 30s");
  });

  it("formats near-zero", () => {
    expect(formatElapsed(0)).toBe("0.0s");
  });
});

describe("relativeTime", () => {
  it("returns 'just now' for recent timestamps", () => {
    const now = new Date().toISOString();
    expect(relativeTime(now)).toBe("just now");
  });

  it("returns minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(relativeTime(fiveMinAgo)).toBe("5m ago");
  });

  it("returns hours ago", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(twoHoursAgo)).toBe("2h ago");
  });

  it("returns days ago", () => {
    const threeDaysAgo = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(relativeTime(threeDaysAgo)).toBe("3d ago");
  });

  it("returns 'just now' for future timestamps", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(relativeTime(future)).toBe("just now");
  });
});

describe("statusBadge", () => {
  it("returns a string containing the status text", () => {
    for (const status of ["completed", "in_progress", "paused", "missing", "unknown"]) {
      const badge = statusBadge(status);
      expect(stripAnsi(badge)).toBe(status);
    }
  });
});
