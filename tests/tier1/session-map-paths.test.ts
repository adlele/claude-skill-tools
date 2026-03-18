import { describe, it, expect } from "vitest";
import { claudeProjectDirPaths } from "../../src/metrics/session-map.js";

describe("claudeProjectDirPaths", () => {
  it("returns exactly 2 paths", () => {
    const paths = claudeProjectDirPaths("/some/worktree/path");
    expect(paths).toHaveLength(2);
  });

  it("both paths are under $HOME/.claude/projects/", () => {
    const home = process.env.HOME ?? "";
    const paths = claudeProjectDirPaths("/some/worktree/path");
    for (const p of paths) {
      expect(p.startsWith(`${home}/.claude/projects/`)).toBe(true);
    }
  });

  it("one path has leading dash stripped, the other keeps it", () => {
    const paths = claudeProjectDirPaths("/some/path");
    // The slug is "-some-path"; slugNoLeadDash is "some-path"
    const home = process.env.HOME ?? "";
    expect(paths[0]).toBe(`${home}/.claude/projects/some-path`);
    expect(paths[1]).toBe(`${home}/.claude/projects/-some-path`);
  });

  it("handles paths without leading slash", () => {
    const paths = claudeProjectDirPaths("relative/path");
    expect(paths).toHaveLength(2);
    // No leading dash to strip, so both are the same
    expect(paths[0]).toBe(paths[1]);
  });
});
