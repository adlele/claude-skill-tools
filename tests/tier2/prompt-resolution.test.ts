import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolvePromptFile,
  getAllPromptFiles,
  PROMPTS_DIR,
  _resetRepoRootCache,
} from "../../src/shared/paths.js";
import { createTempDir, removeTempDir, writeFile } from "../helpers/fixtures.js";

const originalCwd = process.cwd();
let tmpDir: string;

// Suppress console noise
vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(() => {
  tmpDir = fs.realpathSync(createTempDir("cst-prompt-"));
  fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
  process.chdir(tmpDir);
  _resetRepoRootCache();
});

afterAll(() => {
  process.chdir(originalCwd);
  _resetRepoRootCache();
  if (tmpDir) removeTempDir(tmpDir);
});

describe("resolvePromptFile", () => {
  it("repo-local file overrides package default (same filename)", () => {
    // Ensure the package has developer.md
    const pkgFile = path.join(PROMPTS_DIR, "developer.md");
    const pkgExists = fs.existsSync(pkgFile);
    if (!pkgExists) return; // skip if package prompts not available

    // Create repo-local override
    const repoPromptDir = path.join(tmpDir, ".claude", "prompts");
    writeFile(path.join(repoPromptDir, "developer.md"), "# repo override");

    _resetRepoRootCache();
    const resolved = resolvePromptFile("developer.md");
    expect(resolved).toBe(path.join(repoPromptDir, "developer.md"));
  });

  it("repo-local-only file is found", () => {
    const repoPromptDir = path.join(tmpDir, ".claude", "prompts");
    writeFile(path.join(repoPromptDir, "custom-role.md"), "# custom");

    _resetRepoRootCache();
    const resolved = resolvePromptFile("custom-role.md");
    expect(resolved).toBe(path.join(repoPromptDir, "custom-role.md"));
  });

  it("falls back to package prompts when no repo override", () => {
    // No repo prompts dir
    _resetRepoRootCache();
    const resolved = resolvePromptFile("developer.md");
    if (resolved) {
      expect(resolved.startsWith(PROMPTS_DIR)).toBe(true);
    }
    // If package prompt doesn't exist either, resolved is null — that's ok
  });

  it("returns null for non-existent file", () => {
    _resetRepoRootCache();
    const resolved = resolvePromptFile("nonexistent-role-xyz.md");
    expect(resolved).toBeNull();
  });
});

describe("getAllPromptFiles", () => {
  it("includes repo-local-only files", () => {
    const repoPromptDir = path.join(tmpDir, ".claude", "prompts");
    writeFile(path.join(repoPromptDir, "unique-repo-role.md"), "# unique");

    _resetRepoRootCache();
    const all = getAllPromptFiles();
    expect(all.some(f => f.includes("unique-repo-role.md"))).toBe(true);
  });

  it("returns package defaults when no repo dir exists", () => {
    // No .claude/prompts dir
    _resetRepoRootCache();
    const all = getAllPromptFiles();
    // Should at least return package prompts if they exist
    if (fs.existsSync(PROMPTS_DIR)) {
      expect(all.length).toBeGreaterThan(0);
    }
  });
});
