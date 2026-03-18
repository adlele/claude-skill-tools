import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { migrateConfigDir } from "../../src/shared/paths.js";
import { createTempDir, removeTempDir, writeFile } from "../helpers/fixtures.js";

const originalHome = process.env.HOME;
let tmpDir: string;
let fakeHome: string;

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(() => {
  tmpDir = createTempDir("cst-migrate-");
  fakeHome = tmpDir;
  process.env.HOME = fakeHome;
  logSpy.mockClear();
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (tmpDir) removeTempDir(tmpDir);
});

describe("migrateConfigDir", () => {
  it("renames old dir to new when only old exists", () => {
    const oldDir = path.join(fakeHome, ".claude-skill-tools");
    fs.mkdirSync(oldDir, { recursive: true });
    writeFile(path.join(oldDir, "config.json"), '{"adoOrg":"test"}');

    migrateConfigDir();

    const newDir = path.join(fakeHome, "claude-skill-tools");
    expect(fs.existsSync(newDir)).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(
      fs.readFileSync(path.join(newDir, "config.json"), "utf-8"),
    ).toContain("test");
  });

  it("logs warning when both dirs exist, does not crash", () => {
    const oldDir = path.join(fakeHome, ".claude-skill-tools");
    const newDir = path.join(fakeHome, "claude-skill-tools");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });

    expect(() => migrateConfigDir()).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Warning: Both"),
    );
  });

  it("is a no-op when neither dir exists", () => {
    expect(() => migrateConfigDir()).not.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
