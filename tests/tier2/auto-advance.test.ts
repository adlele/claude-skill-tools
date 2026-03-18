import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, removeTempDir } from "../helpers/fixtures.js";

const AUTO_ADVANCE_FILE = ".ralph-auto-advance";

// Mirror the toggle logic from tmux.ts for unit testing
function isAutoAdvanceEnabled(worktree: string): boolean {
  return fs.existsSync(path.join(worktree, AUTO_ADVANCE_FILE));
}

function toggleAutoAdvance(worktree: string): boolean {
  const filePath = path.join(worktree, AUTO_ADVANCE_FILE);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return false;
  }
  fs.writeFileSync(filePath, "");
  return true;
}

describe("ralph auto-advance signal file", () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir("auto-advance-");
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  it("is not enabled by default", () => {
    expect(isAutoAdvanceEnabled(tmpDir)).toBe(false);
  });

  it("is enabled after creating the file", () => {
    fs.writeFileSync(path.join(tmpDir, AUTO_ADVANCE_FILE), "");
    expect(isAutoAdvanceEnabled(tmpDir)).toBe(true);
  });

  it("is disabled after removing the file", () => {
    const filePath = path.join(tmpDir, AUTO_ADVANCE_FILE);
    fs.writeFileSync(filePath, "");
    fs.unlinkSync(filePath);
    expect(isAutoAdvanceEnabled(tmpDir)).toBe(false);
  });

  it("toggle enables when disabled", () => {
    const result = toggleAutoAdvance(tmpDir);
    expect(result).toBe(true);
    expect(isAutoAdvanceEnabled(tmpDir)).toBe(true);
  });

  it("toggle disables when enabled", () => {
    fs.writeFileSync(path.join(tmpDir, AUTO_ADVANCE_FILE), "");
    const result = toggleAutoAdvance(tmpDir);
    expect(result).toBe(false);
    expect(isAutoAdvanceEnabled(tmpDir)).toBe(false);
  });

  it("toggle flips state on repeated calls", () => {
    expect(toggleAutoAdvance(tmpDir)).toBe(true);
    expect(toggleAutoAdvance(tmpDir)).toBe(false);
    expect(toggleAutoAdvance(tmpDir)).toBe(true);
  });
});
