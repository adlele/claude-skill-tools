import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveRepoRoot,
  _resetRepoRootCache,
  PACKAGE_ROOT,
  PROMPTS_DIR,
  HOOKS_DIR,
  getSandboxBase,
  getComposerStateDir,
  getSandboxStateDir,
  getConfigDir,
} from "../../src/shared/paths.js";
import { createTempDir, removeTempDir } from "../helpers/fixtures.js";

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
let tmpDir: string;

// Suppress console noise
vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(() => {
  tmpDir = fs.realpathSync(createTempDir("cst-reporoot-"));
  _resetRepoRootCache();
});

afterAll(() => {
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  _resetRepoRootCache();
  if (tmpDir) removeTempDir(tmpDir);
});

describe("resolveRepoRoot", () => {
  it("finds .git in current directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    process.chdir(tmpDir);
    _resetRepoRootCache();
    expect(resolveRepoRoot()).toBe(tmpDir);
  });

  it("walks up to find .git in parent directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const subDir = path.join(tmpDir, "src", "deep");
    fs.mkdirSync(subDir, { recursive: true });
    process.chdir(subDir);
    _resetRepoRootCache();
    expect(resolveRepoRoot()).toBe(tmpDir);
  });

  it("caches the result after first call", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    process.chdir(tmpDir);
    _resetRepoRootCache();
    const first = resolveRepoRoot();
    // Change directory away but cache should persist
    process.chdir("/");
    expect(resolveRepoRoot()).toBe(first);
  });

  it("throws when no .git found", () => {
    // Create a dir without .git anywhere up the chain
    // Use /tmp itself which shouldn't have .git at root
    const noGitDir = path.join(tmpDir, "no-git");
    fs.mkdirSync(noGitDir, { recursive: true });
    process.chdir(noGitDir);
    _resetRepoRootCache();
    expect(() => resolveRepoRoot()).toThrow("Could not find a git repository");
  });
});

describe("path constants", () => {
  it("PACKAGE_ROOT exists as a directory", () => {
    expect(fs.existsSync(PACKAGE_ROOT)).toBe(true);
  });

  it("PROMPTS_DIR is under PACKAGE_ROOT", () => {
    expect(PROMPTS_DIR.startsWith(PACKAGE_ROOT)).toBe(true);
  });

  it("HOOKS_DIR is under PACKAGE_ROOT", () => {
    expect(HOOKS_DIR.startsWith(PACKAGE_ROOT)).toBe(true);
  });
});

describe("getSandboxBase", () => {
  it("returns sibling directory with -sandboxes suffix", () => {
    fs.mkdirSync(path.join(tmpDir, "my-repo", ".git"), { recursive: true });
    process.chdir(path.join(tmpDir, "my-repo"));
    _resetRepoRootCache();
    const base = getSandboxBase();
    expect(base).toBe(path.join(tmpDir, "my-repo-sandboxes"));
  });
});

describe("getComposerStateDir", () => {
  it("creates and returns .claude/.skill-state/composer/ under repo root", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    process.chdir(tmpDir);
    _resetRepoRootCache();
    const dir = getComposerStateDir();
    expect(dir).toBe(path.join(tmpDir, ".claude/.skill-state/composer"));
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("getSandboxStateDir", () => {
  it("creates and returns .claude/.skill-state/sandbox/ under repo root", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    process.chdir(tmpDir);
    _resetRepoRootCache();
    const dir = getSandboxStateDir();
    expect(dir).toBe(path.join(tmpDir, ".claude/.skill-state/sandbox"));
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("getConfigDir", () => {
  it("creates and returns ~/claude-skill-tools/", () => {
    const fakeHome = path.join(tmpDir, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    const dir = getConfigDir();
    expect(dir).toBe(path.join(fakeHome, "claude-skill-tools"));
    expect(fs.existsSync(dir)).toBe(true);
  });
});
