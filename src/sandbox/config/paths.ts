// config/paths.ts — Path resolution, state management, and file/git helpers

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { die } from "../../shared/ui.js";
import {
  PROMPTS_DIR,
  resolveRepoRoot,
  getSandboxStateDir,
  getSandboxBase as getSandboxBasePath,
  getAllPromptFiles,
} from "../../shared/paths.js";
import type { SandboxState } from "./types.js";

// ============================================================
// PATH RESOLUTION — lazily resolved from shared/paths.ts
// ============================================================

export { PROMPTS_DIR };

export function getRepoRoot(): string {
  return resolveRepoRoot();
}

export function getRepoName(): string {
  return path.basename(resolveRepoRoot());
}

// Re-export under original names for compatibility
export const REPO_ROOT_FN = getRepoRoot;

export function getStateDir(): string {
  return getSandboxStateDir();
}

export function getSandboxBase(): string {
  return getSandboxBasePath();
}

// Re-export under legacy names for compatibility — callers must use these
// in contexts that evaluate lazily (not at import time).
export { resolveRepoRoot as REPO_ROOT_RESOLVE, getSandboxBasePath as SANDBOX_BASE_RESOLVE };

// ============================================================
// SLUG / STATE
// ============================================================

export function slugFromBranch(branch: string): string {
  return branch
    .replace(/^sandbox\//, "")
    .replace(/[/ ]/g, "-")
    .toLowerCase();
}

export function stateFilePath(branch: string): string {
  return path.join(getStateDir(), `${slugFromBranch(branch)}.json`);
}

export function readState(branch: string): SandboxState {
  const file = stateFilePath(branch);
  if (!fs.existsSync(file)) {
    die(`No state file for branch '${branch}'.`, [
      "Run 'sandbox list' to see managed sandboxes.",
      "The sandbox may have been cleaned up already.",
    ]);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    die(`Corrupted state file: ${file}`, [
      `Delete it manually: rm ${file}`,
      "Then run 'sandbox clean' to remove the worktree.",
    ]);
  }
}

export function writeState(state: SandboxState): void {
  const file = path.join(getStateDir(), `${state.slug}.json`);
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

// ============================================================
// GIT / FILE HELPERS
// ============================================================

export function generateRandomHash(): string {
  return randomBytes(2).toString("hex");
}

export function getGitUser(): string {
  const repoRoot = resolveRepoRoot();
  const result = spawnSync("git", ["-C", repoRoot, "config", "user.name"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const name = (result.stdout ?? "").trim();
  return name ? name.toLowerCase().replace(/[ ]/g, "-") : "sandbox";
}

export function git(...args: string[]): { stdout: string; status: number } {
  const repoRoot = resolveRepoRoot();
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    status: result.status ?? 1,
  };
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getPromptFiles(): string[] {
  return getAllPromptFiles();
}

export function getStateFiles(): string[] {
  const stateDir = getStateDir();
  if (!fs.existsSync(stateDir)) return [];
  return fs
    .readdirSync(stateDir)
    .filter(f => f.endsWith(".json"))
    .map(f => path.join(stateDir, f));
}

/**
 * Resolve a slug (or partial slug) to a branch name by scanning state files.
 * Returns the branch if exactly one match is found, otherwise dies with an error.
 */
export function resolveBranchFromId(id: string): string {
  const stateFiles = getStateFiles();
  const matches: SandboxState[] = [];

  for (const f of stateFiles) {
    let state: SandboxState;
    try { state = JSON.parse(fs.readFileSync(f, "utf-8")); } catch { continue; }
    if (state.slug === id || state.slug.startsWith(id) || state.slug.endsWith(id)) {
      matches.push(state);
    }
  }

  if (matches.length === 0) {
    die(`No sandbox found matching id '${id}'.`, [
      "Run 'sandbox list' to see available sandboxes.",
    ]);
  }
  if (matches.length > 1) {
    const slugs = matches.map(m => m.slug).join(", ");
    die(`Ambiguous id '${id}' — matches: ${slugs}`, [
      "Provide a longer prefix or suffix to disambiguate.",
    ]);
  }
  return matches[0].branch;
}

/**
 * Find worktree directories in the sandbox base that have no matching state file.
 */
export function findOrphanedWorktrees(): string[] {
  const base = getSandboxBase();
  if (!fs.existsSync(base)) return [];
  const stateSlugs = new Set(
    getStateFiles().map(f => path.basename(f, ".json")),
  );
  return fs
    .readdirSync(base)
    .filter(d => {
      const full = path.join(base, d);
      try { return fs.statSync(full).isDirectory(); } catch { return false; }
    })
    .filter(d => !stateSlugs.has(d))
    .map(d => path.join(base, d));
}

export function tailFile(filePath: string, lines: number): string {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split("\n").slice(-lines).join("\n");
}
