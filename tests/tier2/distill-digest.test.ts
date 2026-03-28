import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { _resetRepoRootCache, PROMPTS_DIR } from "../../src/shared/paths.js";
import { buildRoleDigest } from "../../src/sandbox/distill.js";
import { createTempDir, removeTempDir, writeFile } from "../helpers/fixtures.js";

const originalCwd = process.cwd();
let tmpDir: string;

vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(() => {
  tmpDir = fs.realpathSync(createTempDir("cst-digest-"));
  fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
  process.chdir(tmpDir);
  _resetRepoRootCache();
});

afterAll(() => {
  process.chdir(originalCwd);
  _resetRepoRootCache();
  if (tmpDir) removeTempDir(tmpDir);
});

describe("buildRoleDigest — filesystem integration", () => {
  it("reads repo-local prompts and includes them in the digest", () => {
    const repoPromptDir = path.join(tmpDir, ".claude", "prompts");
    writeFile(
      path.join(repoPromptDir, "custom-role.md"),
      "# Custom\n\n## Custom Section\n- Custom rule",
    );
    _resetRepoRootCache();

    const digest = buildRoleDigest();

    expect(digest).toContain("## custom-role.md");
    expect(digest).toContain("### Custom Section");
    expect(digest).toContain("- Custom rule");
  });

  it("skips files prefixed with old_", () => {
    const repoPromptDir = path.join(tmpDir, ".claude", "prompts");
    writeFile(
      path.join(repoPromptDir, "old_legacy.md"),
      "# Legacy\n\n## Old Standards\n- Deprecated rule",
    );
    writeFile(
      path.join(repoPromptDir, "active.md"),
      "# Active\n\n## Rules\n- Active rule",
    );
    _resetRepoRootCache();

    const digest = buildRoleDigest();

    expect(digest).toContain("## active.md");
    expect(digest).toContain("- Active rule");
    expect(digest).not.toContain("old_legacy.md");
    expect(digest).not.toContain("Deprecated rule");
  });

  it("repo-local override replaces package prompt of same name", () => {
    const pkgFile = path.join(PROMPTS_DIR, "developer.md");
    if (!fs.existsSync(pkgFile)) return; // skip if package prompts not available

    const repoPromptDir = path.join(tmpDir, ".claude", "prompts");
    writeFile(
      path.join(repoPromptDir, "developer.md"),
      "# Overridden Dev\n\n## Overridden Section\n- Override rule",
    );
    _resetRepoRootCache();

    const digest = buildRoleDigest();

    // The repo-local override should appear, not the package version
    expect(digest).toContain("### Overridden Section");
    expect(digest).toContain("- Override rule");
  });

  it("includes package prompts when no repo-local dir exists", () => {
    // No .claude/prompts dir — should still pick up package prompts
    if (!fs.existsSync(PROMPTS_DIR)) return;
    _resetRepoRootCache();

    const digest = buildRoleDigest();

    expect(digest.length).toBeGreaterThan(0);
    // Package has developer.md with "## Coding Standards"
    expect(digest).toContain("## developer.md");
  });

  it("returns non-empty string for real package prompts", () => {
    if (!fs.existsSync(PROMPTS_DIR)) return;
    _resetRepoRootCache();

    const digest = buildRoleDigest();

    // Verify the digest contains content from multiple prompt files
    expect(digest).toContain("## analyst.md");
    expect(digest).toContain("## reviewer.md");
  });
});
