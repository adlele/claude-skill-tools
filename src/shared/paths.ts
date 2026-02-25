// shared/paths.ts — Centralized path resolution for the package
//
// PACKAGE_ROOT resolves to the installed package location (works from
// node_modules, global install, or local dev).
// resolveRepoRoot() walks up from cwd looking for .git/ — cached after first call.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Package root ─────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
// In compiled form this file lives at dist/shared/paths.js — two levels below package root.
export const PACKAGE_ROOT = path.resolve(path.dirname(__filename), "../..");

// ── Prompts directory ────────────────────────────────────────

export const PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");

// ── Hooks directory ──────────────────────────────────────────

export const HOOKS_DIR = path.join(PACKAGE_ROOT, "hooks");

// ── Repo root (lazy, cached) ────────────────────────────────

let _repoRoot: string | null = null;

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

// ── Sandbox base directory ───────────────────────────────────

export function getSandboxBase(): string {
  const repoRoot = resolveRepoRoot();
  const repoName = path.basename(repoRoot);
  return path.join(path.dirname(repoRoot), `${repoName}-sandboxes`);
}
