// shared/paths.ts — Centralized path resolution for the package
//
// PACKAGE_ROOT resolves to the installed package location (works from
// node_modules, global install, or local dev).
// resolveRepoRoot() walks up from cwd looking for .git/ — cached after first call.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Package root ─────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
// In compiled form this file lives at dist/shared/paths.js — two levels below package root.
export const PACKAGE_ROOT = path.resolve(path.dirname(__filename), "../..");

// ── Prompts directory ────────────────────────────────────────

export const PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");

/**
 * Returns the repo-local prompt override directory (<repoRoot>/.claude/prompts/)
 * if it exists, or null.
 */
function getRepoPromptsDir(): string | null {
  try {
    const dir = path.join(resolveRepoRoot(), ".claude", "prompts");
    return fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a single prompt file by name (e.g. "developer.md").
 * Checks repo-local `.claude/prompts/` first, falls back to package `PROMPTS_DIR`.
 * Returns the full path, or null if not found in either location.
 */
export function resolvePromptFile(filename: string): string | null {
  const repoDir = getRepoPromptsDir();
  if (repoDir) {
    const repoFile = path.join(repoDir, filename);
    if (fs.existsSync(repoFile)) return repoFile;
  }
  const pkgFile = path.join(PROMPTS_DIR, filename);
  return fs.existsSync(pkgFile) ? pkgFile : null;
}

/**
 * Return all prompt files, merging repo-local overrides with package defaults.
 * Repo-local files take precedence per-file; repo-local-only files are included too.
 * Returns full paths.
 */
export function getAllPromptFiles(): string[] {
  const pkgFiles = new Map<string, string>();
  if (fs.existsSync(PROMPTS_DIR)) {
    for (const f of fs.readdirSync(PROMPTS_DIR)) {
      if (f.endsWith(".md")) pkgFiles.set(f, path.join(PROMPTS_DIR, f));
    }
  }

  const repoDir = getRepoPromptsDir();
  if (repoDir) {
    for (const f of fs.readdirSync(repoDir)) {
      if (f.endsWith(".md")) pkgFiles.set(f, path.join(repoDir, f));
    }
  }

  return Array.from(pkgFiles.values());
}

// ── Hooks directory ──────────────────────────────────────────

export const HOOKS_DIR = path.join(PACKAGE_ROOT, "hooks");

// ── Repo root (lazy, cached) ────────────────────────────────

let _repoRoot: string | null = null;

/** Reset the cached repo root — for testing only. */
export function _resetRepoRootCache(): void {
  _repoRoot = null;
}

/**
 * Walk up from `process.cwd()` looking for a `.git/` directory.
 * Caches the result after the first successful call.
 * Throws if no git repo is found.
 */
export function resolveRepoRoot(): string {
  if (_repoRoot !== null) return _repoRoot;

  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      _repoRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Could not find a git repository. Run this command from within a git repo.",
      );
    }
    dir = parent;
  }
}

// ── State directories (repo-local, gitignored) ──────────────

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getComposerStateDir(): string {
  return ensureDir(
    path.join(resolveRepoRoot(), ".claude/.skill-state/composer"),
  );
}

export function getSandboxStateDir(): string {
  return ensureDir(
    path.join(resolveRepoRoot(), ".claude/.skill-state/sandbox"),
  );
}

// ── User-level config directory ──────────────────────────────

export function getConfigDir(): string {
  return ensureDir(path.join(os.homedir(), "claude-skill-tools"));
}

export function getConfigFilePath(): string {
  return path.join(getConfigDir(), "config.json");
}

/**
 * Migrate from the old dot-prefixed directory (~/.claude-skill-tools)
 * to the new non-hidden directory (~/claude-skill-tools).
 * Idempotent — safe to call from multiple entry points.
 */
export function migrateConfigDir(): void {
  const home = os.homedir();
  const oldDir = path.join(home, ".claude-skill-tools");
  const newDir = path.join(home, "claude-skill-tools");

  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    try {
      fs.renameSync(oldDir, newDir);
      console.log(`  Migrated config directory: ${oldDir} -> ${newDir}`);
    } catch {
      // Race condition: another process may have already migrated
      if (!fs.existsSync(newDir)) {
        throw new Error(`Failed to migrate ${oldDir} to ${newDir}`);
      }
    }
  } else if (fs.existsSync(oldDir) && fs.existsSync(newDir)) {
    console.log(
      `  Warning: Both ${oldDir} and ${newDir} exist. Using ${newDir}. You may delete the old directory.`,
    );
  }
}

// ── Repo-level config ────────────────────────────────────────

/**
 * Returns the repo-level config file path (<repoRoot>/.claude/.skill-state/config.json)
 * if the file exists, or null.
 */
export function getRepoConfigFilePath(): string | null {
  try {
    const configPath = path.join(
      resolveRepoRoot(), ".claude", ".skill-state", "config.json",
    );
    return fs.existsSync(configPath) ? configPath : null;
  } catch {
    return null;
  }
}

// ── Sandbox base directory ───────────────────────────────────

export function getSandboxBase(): string {
  const repoRoot = resolveRepoRoot();
  const repoName = path.basename(repoRoot);
  return path.join(path.dirname(repoRoot), `${repoName}-sandboxes`);
}
