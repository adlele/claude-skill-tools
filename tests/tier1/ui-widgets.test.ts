import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  red,
  green,
  yellow,
  cyan,
  dim,
  bold,
  banner,
  stepResult,
  warn,
  errorBlock,
  die,
  stripAnsi,
} from "../../src/shared/ui.js";
import { progressBar, spinnerLine } from "../../src/composer/ui.js";

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(() => {
  logSpy.mockClear();
});

describe("color functions", () => {
  // In non-TTY test environments, colors may be no-ops.
  // We verify they at least return the input text.

  it("red wraps or passes through text", () => {
    expect(stripAnsi(red("hello"))).toBe("hello");
  });

  it("green wraps or passes through text", () => {
    expect(stripAnsi(green("hello"))).toBe("hello");
  });

  it("yellow wraps or passes through text", () => {
    expect(stripAnsi(yellow("hello"))).toBe("hello");
  });

  it("cyan wraps or passes through text", () => {
    expect(stripAnsi(cyan("hello"))).toBe("hello");
  });

  it("dim wraps or passes through text", () => {
    expect(stripAnsi(dim("hello"))).toBe("hello");
  });

  it("bold wraps or passes through text", () => {
    expect(stripAnsi(bold("hello"))).toBe("hello");
  });
});

describe("banner", () => {
  it("prints title and fields to console", () => {
    banner("Test Banner", [
      ["Key1", "Value1"],
      ["Key2", "Value2"],
    ]);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map(c => c[0]).join("\n");
    expect(stripAnsi(output)).toContain("Test Banner");
    expect(stripAnsi(output)).toContain("Key1:");
    expect(stripAnsi(output)).toContain("Value1");
  });
});

describe("stepResult", () => {
  it("prints success message", () => {
    stepResult(true, "Build completed");
    const output = logSpy.mock.calls[0][0];
    expect(stripAnsi(output)).toContain("Build completed");
  });

  it("prints failure message", () => {
    stepResult(false, "Build failed");
    const output = logSpy.mock.calls[0][0];
    expect(stripAnsi(output)).toContain("Build failed");
  });

  it("includes elapsed time when provided", () => {
    stepResult(true, "Done", 5000);
    const output = stripAnsi(logSpy.mock.calls[0][0]);
    expect(output).toContain("5.0s");
  });
});

describe("warn", () => {
  it("prints warning message", () => {
    warn("Something happened");
    const output = logSpy.mock.calls[0][0];
    expect(stripAnsi(output)).toContain("Something happened");
  });
});

describe("errorBlock", () => {
  it("prints title", () => {
    errorBlock("Something broke");
    const output = logSpy.mock.calls[0][0];
    expect(stripAnsi(output)).toContain("Something broke");
  });

  it("prints details when provided", () => {
    errorBlock("Error", "more details");
    const output = logSpy.mock.calls[0][0];
    expect(stripAnsi(output)).toContain("more details");
  });

  it("prints numbered suggestions", () => {
    errorBlock("Error", undefined, ["Try this", "Or this"]);
    const output = stripAnsi(logSpy.mock.calls[0][0]);
    expect(output).toContain("1.");
    expect(output).toContain("Try this");
    expect(output).toContain("2.");
    expect(output).toContain("Or this");
  });
});

describe("die", () => {
  it("calls process.exit(1)", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => { throw new Error("exit"); });
    expect(() => die("fatal error")).toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("progressBar", () => {
  it("returns a string with progress info", () => {
    const bar = progressBar(3, 10);
    expect(stripAnsi(bar)).toContain("3/10");
  });

  it("shows full bar at 100%", () => {
    const bar = progressBar(5, 5);
    expect(stripAnsi(bar)).toContain("5/5");
  });

  it("shows empty bar at 0%", () => {
    const bar = progressBar(0, 10);
    expect(stripAnsi(bar)).toContain("0/10");
  });
});

describe("spinnerLine", () => {
  it("returns a string with elapsed time", () => {
    const start = Date.now() - 5000;
    const line = spinnerLine(0, start);
    expect(stripAnsi(line)).toContain("Running...");
  });

  it("cycles through spinner frames", () => {
    const start = Date.now();
    const line0 = spinnerLine(0, start);
    const line1 = spinnerLine(1, start);
    // Different tick should produce different frame
    // (both still contain "Running..." but the frame character differs)
    expect(line0).not.toBe(line1);
  });
});
