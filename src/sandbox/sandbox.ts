// sandbox.ts — Manage isolated git worktree sandboxes for Claude Code
// Usage: sandbox <create|start|ralph|distill|status|cleanup|list|roles> [options]

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync, spawn } from "node:child_process";

import { nowISO, promptUser, sleep } from "../shared/utils.js";
import { die } from "../shared/ui.js";
import * as ui from "../shared/ui.js";
import { resolveRepoRoot, PROMPTS_DIR, resolvePromptFile, migrateConfigDir } from "../shared/paths.js";
import type { SandboxState, CreateResult } from "./config/types.js";
import {
  getRepoRoot,
  getSandboxBase,
  slugFromBranch,
  stateFilePath,
  readState,
  writeState,
  generateRandomHash,
  getGitUser,
  git,
  isProcessRunning,
  getPromptFiles,
  getStateFiles,
  tailFile,
  resolveBranchFromId,
  findOrphanedWorktrees,
} from "./config/paths.js";
import { generateAuditSummary } from "./audit.js";
import {
  expandRanges,
  parseComments,
  filterIgnored,
  runAgentWithTimer,
  runInteractiveAgentWithLog,
  generateReadableLog,
} from "./ralph-helpers.js";
import { addClaudeSession } from "../metrics/session-map.js";
import {
  generateFeatureRequestChangesSummary,
  generateImprovedFeatureRequest,
  printDistillBanner,
} from "./distill.js";
import { calculateSizes, formatSizeKB } from "./size.js";
import { extractAllComments, synthesizeLearnings } from "./retro.js";

// ============================================================
// COMMANDS
// ============================================================

// --- roles ---

function cmdRoles(): void {
  const promptFiles = getPromptFiles();

  if (promptFiles.length === 0) {
    console.log(`No preset roles found in ${PROMPTS_DIR}`);
    return;
  }

  console.log("Available preset roles:");
  console.log("");

  for (const f of promptFiles) {
    const name = path.basename(f, ".md");
    const firstLine = fs.readFileSync(f, "utf-8").split("\n")[0] ?? "";
    const desc = firstLine.replace(/^#\s*/, "");
    console.log(`  ${name.padEnd(12)} ${desc}`);
  }

  console.log("");
  console.log(
    "Usage: sandbox start --role <name> [--mode interactive|headless]",
  );
}

// --- helpers ---

function sandboxStatus(state: SandboxState): string {
  if (!fs.existsSync(state.worktree)) return "MISSING";
  if (state.mode === "headless" && state.pid && state.pid !== "") {
    const pid = parseInt(state.pid, 10);
    return isProcessRunning(pid) ? "RUNNING" : "STOPPED";
  }
  return "ACTIVE";
}

// --- list ---

async function cmdList(): Promise<void> {
  const jsonFiles = getStateFiles();

  if (jsonFiles.length === 0) {
    console.log("No sandboxes found.");
    return;
  }

  // Parse state files, skip corrupted
  const entries: { state: SandboxState; status: string }[] = [];
  for (const f of jsonFiles) {
    let state: SandboxState;
    try { state = JSON.parse(fs.readFileSync(f, "utf-8")); } catch {
      ui.warn(`Skipping corrupted state file: ${f}`);
      continue;
    }
    entries.push({ state, status: sandboxStatus(state) });
  }

  if (entries.length === 0) return;

  // Sort by created timestamp, most recent first
  entries.sort((a, b) => {
    const ta = new Date(a.state.created || "").getTime() || 0;
    const tb = new Date(b.state.created || "").getTime() || 0;
    return tb - ta;
  });

  // Calculate sizes in parallel with progress
  const sizeResults = await calculateSizes(
    entries.map(e => ({
      slug: e.state.slug,
      branch: e.state.branch,
      worktree: e.state.worktree,
    })),
  );
  const sizeMap = new Map(sizeResults.map(r => [r.slug, r]));

  const idWidth = Math.max(6, ...entries.map(e => e.state.slug.length)) + 2;
  const sizeWidth = 10;
  const createdWidth = 10;
  const header = [
    "ID".padEnd(idWidth),
    "MODE".padEnd(12),
    "STATUS".padEnd(10),
    "SIZE".padEnd(sizeWidth),
    "CREATED".padEnd(createdWidth),
    "BRANCH",
  ].join(" ");
  const divider = [
    "─".repeat(idWidth),
    "─".repeat(12),
    "─".repeat(10),
    "─".repeat(sizeWidth),
    "─".repeat(createdWidth),
    "──────",
  ].join(" ");

  console.log(header);
  console.log(divider);

  for (const { state, status } of entries) {
    const badge = ui.statusBadge(status);
    const ansiOverhead = badge.length - status.length;
    const created = state.created ? ui.relativeTime(state.created) : ui.dim("—");
    const createdOverhead = state.created ? 0 : created.length - "—".length;
    const sr = sizeMap.get(state.slug);
    const sizeStr = sr?.sizeHuman ?? "--";
    console.log([
      state.slug.padEnd(idWidth),
      state.mode.padEnd(12),
      badge.padEnd(10 + ansiOverhead),
      sizeStr.padEnd(sizeWidth),
      created.padEnd(createdWidth + createdOverhead),
      state.branch,
    ].join(" "));
  }

  // Warn about missing worktrees
  const missing = entries.filter(e => e.status === "MISSING");
  if (missing.length > 0) {
    console.log("");
    ui.warn(`${missing.length} sandbox(es) have missing worktrees. Run: sandbox clean --missing`);
  }

  // Warn about orphaned worktree dirs
  const orphans = findOrphanedWorktrees();
  if (orphans.length > 0) {
    ui.warn(`${orphans.length} orphaned worktree dir(s) found. Run: sandbox clean --orphans`);
  }
}

// --- size ---

async function cmdSize(args: string[]): Promise<void> {
  let branch = "";
  let id = "";
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--branch":
        branch = args[++i] ?? "";
        i++;
        break;
      case "--id":
        id = args[++i] ?? "";
        i++;
        break;
      default:
        if (!args[i].startsWith("--")) {
          id = args[i];
          i++;
        } else {
          die(`Unknown option for size: ${args[i]}`, ["Run 'sandbox --help' for usage."]);
        }
        continue;
    }
  }

  // Single-sandbox mode
  if (id && !branch) {
    branch = resolveBranchFromId(id);
  }
  if (branch) {
    const state = readState(branch);
    const results = await calculateSizes(
      [{ slug: state.slug, branch: state.branch, worktree: state.worktree }],
      false,
    );
    const r = results[0];
    if (r.sizeKB == null) {
      console.log(`${ui.bold(state.branch)}: ${ui.dim("-- (worktree missing)")} ${ui.dim(state.worktree)}`);
    } else {
      console.log(`${ui.bold(state.branch)}: ${r.sizeHuman}`);
    }
    return;
  }

  // All-sandboxes mode
  const jsonFiles = getStateFiles();
  if (jsonFiles.length === 0) {
    console.log("No sandboxes found.");
    return;
  }

  const entries: { state: SandboxState; status: string }[] = [];
  for (const f of jsonFiles) {
    let state: SandboxState;
    try { state = JSON.parse(fs.readFileSync(f, "utf-8")); } catch {
      ui.warn(`Skipping corrupted state file: ${f}`);
      continue;
    }
    entries.push({ state, status: sandboxStatus(state) });
  }
  if (entries.length === 0) return;

  entries.sort((a, b) => {
    const ta = new Date(a.state.created || "").getTime() || 0;
    const tb = new Date(b.state.created || "").getTime() || 0;
    return tb - ta;
  });

  const sizeResults = await calculateSizes(
    entries.map(e => ({
      slug: e.state.slug,
      branch: e.state.branch,
      worktree: e.state.worktree,
    })),
  );
  const sizeMap = new Map(sizeResults.map(r => [r.slug, r]));

  const idWidth = Math.max(6, ...entries.map(e => e.state.slug.length)) + 2;
  const sizeWidth = 10;
  const header = [
    "ID".padEnd(idWidth),
    "SIZE".padEnd(sizeWidth),
    "STATUS".padEnd(10),
    "BRANCH",
  ].join(" ");
  const divider = [
    "─".repeat(idWidth),
    "─".repeat(sizeWidth),
    "─".repeat(10),
    "──────",
  ].join(" ");

  console.log(header);
  console.log(divider);

  for (const { state, status } of entries) {
    const badge = ui.statusBadge(status);
    const ansiOverhead = badge.length - status.length;
    const sr = sizeMap.get(state.slug);
    const sizeStr = sr?.sizeHuman ?? "--";
    console.log([
      state.slug.padEnd(idWidth),
      sizeStr.padEnd(sizeWidth),
      badge.padEnd(10 + ansiOverhead),
      state.branch,
    ].join(" "));
  }

  const totalKB = sizeResults.reduce((sum, r) => sum + (r.sizeKB ?? 0), 0);
  console.log("");
  console.log(`  Total: ${ui.bold(formatSizeKB(totalKB))}`);
}

// --- status ---

async function cmdStatus(args: string[]): Promise<void> {
  let branch = "";
  let id = "";
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--branch":
        branch = args[++i] ?? "";
        i++;
        break;
      case "--id":
        id = args[++i] ?? "";
        i++;
        break;
      default:
        // Treat bare arg (no --) as a short ID
        if (!args[i].startsWith("--")) {
          id = args[i];
          i++;
        } else {
          die(`Unknown option for status: ${args[i]}`, ["Run 'sandbox --help' for usage."]);
        }
        continue;
    }
  }

  if (id && !branch) {
    branch = resolveBranchFromId(id);
  }

  if (!branch) {
    await cmdList();
    return;
  }

  const state = readState(branch);
  const SANDBOX_BASE = getSandboxBase();

  console.log(`=== Sandbox: ${branch} ===`);
  console.log(`Worktree: ${state.worktree}`);
  console.log(`Mode:     ${state.mode}`);
  console.log(`Base:     ${state.base}`);

  if (!fs.existsSync(state.worktree)) {
    console.log("Status:   MISSING (worktree directory not found)");
    return;
  }

  if (state.mode === "headless" && state.pid && state.pid !== "") {
    const pid = parseInt(state.pid, 10);
    if (isProcessRunning(pid)) {
      console.log(`Status:   RUNNING (PID ${state.pid})`);
    } else {
      console.log(`Status:   STOPPED (PID ${state.pid} no longer running)`);
    }

    const logFile = path.join(SANDBOX_BASE, `${state.slug}.log`);
    if (fs.existsSync(logFile)) {
      console.log("");
      console.log("--- Last 30 lines of log ---");
      console.log(tailFile(logFile, 30));
      console.log("---");
    }
  } else {
    console.log("Status:   INTERACTIVE");
  }

  // Git status
  console.log("");
  console.log("--- Changes ---");
  const diff = spawnSync(
    "git",
    ["-C", state.worktree, "diff", "--stat", "HEAD"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(diff.stdout?.trim() || "(no changes)");

  console.log("");
  console.log(`--- Commits since ${state.base} ---`);
  const log = spawnSync(
    "git",
    ["-C", state.worktree, "log", "--oneline", `origin/${state.base}..HEAD`],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(log.stdout?.trim() || "(no commits)");
}

// --- create ---

async function cmdCreate(args: string[]): Promise<CreateResult> {
  let branch = "";
  let base = "master";
  let setup = false;
  let context = "";
  let contextFile = "";

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--branch":
        branch = args[++i] ?? "";
        i++;
        break;
      case "--base":
        base = args[++i] ?? "";
        i++;
        break;
      case "--setup":
        setup = true;
        i++;
        break;
      case "--context":
        context = args[++i] ?? "";
        i++;
        break;
      case "--context-file":
        contextFile = args[++i] ?? "";
        i++;
        break;
      default:
        die(`Unknown option for create: ${args[i]}`, ["Run 'sandbox --help' for usage."]);
    }
  }

  const REPO_ROOT = getRepoRoot();
  const SANDBOX_BASE = getSandboxBase();

  // Auto-generate branch name if not provided
  if (!branch) {
    const hash = generateRandomHash();
    const gitUser = getGitUser();
    branch = `users/${gitUser}/worktree-${hash}`;
  }

  const slug = slugFromBranch(branch);
  const worktreePath = path.join(SANDBOX_BASE, slug);

  // Validate branch doesn't already exist
  if (
    git("show-ref", "--verify", "--quiet", `refs/heads/${branch}`).status === 0
  ) {
    die(`Branch '${branch}' already exists`);
  }

  // Validate worktree path doesn't exist
  if (fs.existsSync(worktreePath)) {
    die(`Worktree path '${worktreePath}' already exists`);
  }

  // Fetch base
  console.log(`Fetching origin/${base}...`);
  spawnSync("git", ["-C", REPO_ROOT, "fetch", "origin", base, "--quiet"], {
    stdio: "ignore",
  });

  // Create sandbox directory
  fs.mkdirSync(SANDBOX_BASE, { recursive: true });

  // Create worktree
  console.log(`Creating worktree at ${worktreePath}...`);
  const wtResult = spawnSync(
    "git",
    [
      "-C",
      REPO_ROOT,
      "worktree",
      "add",
      "-b",
      branch,
      "--no-track",
      worktreePath,
      `origin/${base}`,
      "--quiet",
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (wtResult.status !== 0) {
    die(`Failed to create worktree: ${wtResult.stderr?.trim()}`);
  }

  // Dependency setup: --setup runs full install, otherwise symlink from main repo
  if (setup) {
    console.log("Running yarn predev in worktree...");
    spawnSync("yarn", ["predev"], { cwd: worktreePath, stdio: "inherit" });
  } else {
    const mainNodeModules = path.join(REPO_ROOT, "node_modules");
    const worktreeNodeModules = path.join(worktreePath, "node_modules");
    if (fs.existsSync(mainNodeModules) && !fs.existsSync(worktreeNodeModules)) {
      console.log("Linking node_modules packages from main repo...");
      // Create a real node_modules directory and symlink each top-level entry
      // inside it. A single directory symlink causes bundlers (webpack) to
      // resolve the real path outside the worktree root, which breaks
      // CSS-in-JS libraries like FluentUI/Griffel that rely on singleton
      // style registries scoped to the project.
      fs.mkdirSync(worktreeNodeModules);
      for (const entry of fs.readdirSync(mainNodeModules)) {
        fs.symlinkSync(
          path.join(mainNodeModules, entry),
          path.join(worktreeNodeModules, entry),
        );
      }
    }
  }

  // Create bin/yarn shim to intercept `yarn add` and re-symlink after install
  const binDir = path.join(worktreePath, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "yarn"),
    `#!/bin/bash
REAL_YARN="$(which -a yarn | grep -v "$0" | head -1)"
SANDBOX_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$1" = "add" ]; then
  shift
  REAL_YARN="$REAL_YARN" exec npx tsx "$SANDBOX_DIR/tools/sandbox-yarn-add.ts" "$@"
else
  exec "$REAL_YARN" "$@"
fi
`,
  );
  fs.chmodSync(path.join(binDir, "yarn"), 0o755);

  // Create tools/sandbox-yarn-add.ts — runs real yarn add then re-symlinks
  // packages that exist in the main repo's node_modules
  const toolsDir = path.join(worktreePath, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  const mainNodeModules = path.join(REPO_ROOT, "node_modules");
  fs.writeFileSync(
    path.join(toolsDir, "sandbox-yarn-add.ts"),
    `import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REAL_YARN = process.env.REAL_YARN;
if (!REAL_YARN) {
  console.error("REAL_YARN environment variable not set");
  process.exit(1);
}

const MAIN_NODE_MODULES = ${JSON.stringify(mainNodeModules)};
const SANDBOX_DIR = path.resolve(import.meta.dirname, "..");
const SANDBOX_NODE_MODULES = path.join(SANDBOX_DIR, "node_modules");

const packages = process.argv.slice(2);
if (packages.length === 0) {
  console.error("Usage: sandbox-yarn-add <package> [package...]");
  process.exit(1);
}

// Run the real yarn add
console.log(\`Running: \${REAL_YARN} add \${packages.join(" ")}\\n\`);
execSync(\`"\${REAL_YARN}" add \${packages.join(" ")}\`, {
  cwd: SANDBOX_DIR,
  stdio: "inherit",
});

// Re-symlink: for every entry in sandbox node_modules, if the same entry
// exists in the main repo's node_modules, replace with a symlink.
// This keeps only sandbox-specific (newly added) packages as real directories.
console.log("\\nRe-linking shared packages...");
let relinked = 0;
for (const entry of fs.readdirSync(SANDBOX_NODE_MODULES)) {
  const sandboxEntry = path.join(SANDBOX_NODE_MODULES, entry);
  const mainEntry = path.join(MAIN_NODE_MODULES, entry);

  // Skip entries that are already symlinks
  try {
    if (fs.lstatSync(sandboxEntry).isSymbolicLink()) continue;
  } catch { continue; }

  // If the package exists in main node_modules, replace with symlink
  if (fs.existsSync(mainEntry)) {
    fs.rmSync(sandboxEntry, { recursive: true, force: true });
    fs.symlinkSync(mainEntry, sandboxEntry);
    relinked++;
  }
}
console.log(\`Re-linked \${relinked} package(s). Sandbox-only packages preserved.\\n\`);
`,
  );

  // Copy all role prompts into the sandbox
  const promptFiles = getPromptFiles();
  if (promptFiles.length > 0) {
    fs.mkdirSync(path.join(worktreePath, "prompts"), { recursive: true });
    for (const f of promptFiles) {
      fs.copyFileSync(f, path.join(worktreePath, "prompts", path.basename(f)));
    }
  }

  // Create .code-workspace file with sandbox color customizations.
  // Using a workspace file avoids the race condition where VS Code overwrites
  // .vscode/settings.json during startup.
  fs.writeFileSync(
    path.join(worktreePath, "sandbox.code-workspace"),
    JSON.stringify(
      {
        folders: [{ path: "." }],
        settings: {
          "workbench.colorCustomizations": {
            "statusBar.background": "#d97706",
            "statusBar.foreground": "#ffffff",
            "statusBar.debuggingBackground": "#d97706",
            "statusBar.noFolderBackground": "#d97706",
            "titleBar.activeBackground": "#b45309",
            "titleBar.activeForeground": "#ffffff",
            "titleBar.inactiveBackground": "#92400e",
            "titleBar.inactiveForeground": "#ffffffcc",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );

  // Ensure sandbox artifacts are git-ignored and claude-ignored so the ralph
  // loop doesn't try to commit or review them.
  const sandboxIgnores = [
    "sandbox.code-workspace",
    "prompts/",
    "bin/",
    "tools/",
    "ralph-*.log",
    "ralph-log.md",
    "ignored-comments.txt",
    "feature-request.md",
    "audit-raw.jsonl",
    "audit-log.md",
    ".ralph-auto-advance",
  ];
  const gitignorePath = path.join(worktreePath, ".gitignore");
  let existingIgnore = "";
  if (fs.existsSync(gitignorePath)) {
    existingIgnore = fs.readFileSync(gitignorePath, "utf-8");
  }
  const newEntries = sandboxIgnores.filter(
    e => !existingIgnore.split("\n").includes(e),
  );
  if (newEntries.length > 0) {
    fs.appendFileSync(gitignorePath, newEntries.join("\n") + "\n");
  }

  // Write sandbox-specific .claude/settings.json so Claude Code doesn't prompt
  // for trust. The worktree inherits the repo's settings which include hooks
  // pointing to paths outside the worktree — replace with permissive settings
  // since the sandbox is already an isolated worktree.
  const claudeDir = path.join(worktreePath, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify(
      {
        permissions: {
          allow: ["Bash(*)", "Edit(*)", "Write(*)", "Read(*)", "Glob(*)", "Grep(*)"],
        },
      },
      null,
      2,
    ) + "\n",
  );

  // Seed feature-request.md if context was provided
  if (context) {
    fs.writeFileSync(
      path.join(worktreePath, "feature-request.md"),
      context + "\n",
    );
    console.log("Seeded feature-request.md from --context");
  } else if (contextFile) {
    if (!fs.existsSync(contextFile))
      die(`Context file not found: ${contextFile}`);
    fs.copyFileSync(contextFile, path.join(worktreePath, "feature-request.md"));
    console.log(`Seeded feature-request.md from ${contextFile}`);
  }

  // Save state
  writeState({
    branch,
    slug,
    worktree: worktreePath,
    pid: "",
    mode: "interactive",
    base,
    model: "sonnet",
    created: nowISO(),
  });

  console.log("");
  console.log("=== Sandbox Created ===");
  console.log(`Branch:   ${branch}`);
  console.log(`Worktree: ${worktreePath}`);
  console.log(`Base:     origin/${base}`);
  console.log("");
  console.log(
    "Available roles (switch by restarting claude with a different prompt):",
  );
  for (const f of promptFiles) {
    const name = path.basename(f, ".md");
    const firstLine = fs.readFileSync(f, "utf-8").split("\n")[0] ?? "";
    const desc = firstLine.replace(/^#\s*/, "");
    console.log(
      `  claude --system-prompt "$(cat prompts/${name}.md)"    # ${desc}`,
    );
  }
  console.log("");

  // Make workspace file read-only so VS Code can't strip the color overrides
  fs.chmodSync(path.join(worktreePath, "sandbox.code-workspace"), 0o444);

  // Open VS Code with the workspace file (has color customizations baked in)
  console.log("Opening VS Code...");
  spawnSync("code", [path.join(worktreePath, "sandbox.code-workspace")], {
    stdio: "ignore",
  });

  return { branch, worktree: worktreePath };
}


// --- cleanup ---

async function cmdClean(args: string[]): Promise<void> {
  // Interactive mode: no args + TTY → show list and prompt
  if (args.length === 0) {
    const jsonFiles = getStateFiles();
    if (jsonFiles.length === 0) {
      console.log("No sandboxes to clean.");
      return;
    }
    if (!process.stdin.isTTY) {
      die("Missing target for clean.", [
        "Run 'sandbox clean --help' for usage.",
        "Run 'sandbox list' to see available sandboxes.",
      ]);
    }
    const items: { state: SandboxState; status: string }[] = [];
    for (const f of jsonFiles) {
      let state: SandboxState;
      try { state = JSON.parse(fs.readFileSync(f, "utf-8")); } catch { continue; }
      items.push({ state, status: sandboxStatus(state) });
    }
    if (items.length === 0) {
      console.log("No sandboxes to clean.");
      return;
    }
    console.log("");
    for (let idx = 0; idx < items.length; idx++) {
      const { state, status } = items[idx];
      console.log(`  ${ui.dim(`${idx + 1}.`)} ${state.slug}  ${ui.statusBadge(status)}  ${ui.dim(state.branch)}`);
    }
    console.log("");
    const answer = await promptUser("  Enter number, short ID, or flag (--all/--stopped/--missing): ");
    const input = answer.trim();
    if (!input) return;
    // If numeric, resolve to slug
    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= 1 && num <= items.length) {
      return cmdClean(["--branch", items[num - 1].state.branch]);
    }
    // Otherwise pass through as args
    return cmdClean(input.split(/\s+/));
  }

  let branch = "";
  let id = "";
  let keepBranch = false;
  let force = false;
  let all = false;
  let statusFilter = "";

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--branch":
        branch = args[++i] ?? "";
        i++;
        break;
      case "--id":
        id = args[++i] ?? "";
        i++;
        break;
      case "--keep-branch":
        keepBranch = true;
        i++;
        break;
      case "--force":
        force = true;
        i++;
        break;
      case "--all":
        all = true;
        i++;
        break;
      case "--stopped":
      case "--missing":
      case "--active":
      case "--running":
        statusFilter = args[i].slice(2); // strip "--"
        i++;
        break;
      case "--orphans":
        statusFilter = "orphans";
        i++;
        break;
      default:
        // Treat bare arg (no --) as a short ID
        if (!args[i].startsWith("--")) {
          id = args[i];
          i++;
        } else {
          die(`Unknown option for clean: ${args[i]}`, ["Run 'sandbox --help' for usage."]);
        }
    }
  }

  const REPO_ROOT = getRepoRoot();
  const SANDBOX_BASE = getSandboxBase();

  // Resolve --id (or positional short ID) to a branch name
  if (id && !branch) {
    branch = resolveBranchFromId(id);
  }

  // Handle --orphans: clean worktree dirs with no state file
  if (statusFilter === "orphans") {
    const orphans = findOrphanedWorktrees();
    if (orphans.length === 0) {
      console.log("No orphaned worktrees found.");
      return;
    }
    console.log(`Found ${orphans.length} orphaned worktree dir(s):`);
    for (const o of orphans) { console.log(`  ${o}`); }
    if (!force) {
      console.log("");
      const answer = await promptUser(`  Remove all ${orphans.length} orphaned dir(s)? [y/N] `);
      if (!/^[yY]$/.test(answer.trim())) {
        console.log("  Aborted.");
        return;
      }
    }
    for (const o of orphans) {
      spawnSync("git", ["-C", REPO_ROOT, "worktree", "remove", o, "--force"], { stdio: "ignore" });
      if (fs.existsSync(o)) {
        spawnSync("rm", ["-rf", o], { stdio: "ignore" });
      }
      console.log(`  Removed: ${o}`);
    }
    return;
  }

  // Bulk clean: --all or --stopped/--missing/--active/--running
  if (all || statusFilter) {
    const jsonFiles = getStateFiles();
    if (jsonFiles.length === 0) {
      console.log("No sandboxes to clean up.");
      return;
    }

    // Filter by status if requested (skip corrupted state files)
    const targets: SandboxState[] = [];
    for (const f of jsonFiles) {
      let state: SandboxState;
      try { state = JSON.parse(fs.readFileSync(f, "utf-8")); } catch {
        ui.warn(`Skipping corrupted state file: ${f}`);
        continue;
      }
      if (!statusFilter || sandboxStatus(state).toLowerCase() === statusFilter) {
        targets.push(state);
      }
    }

    if (targets.length === 0) {
      console.log(`No sandboxes matching status '${statusFilter}'.`);
      return;
    }

    const label = statusFilter ? `${statusFilter} ` : "";
    console.log(`=== Cleaning up ${targets.length} ${label}sandbox(es) ===`);
    console.log("");
    for (let idx = 0; idx < targets.length; idx++) {
      const state = targets[idx];
      console.log(`[${idx + 1}/${targets.length}] ${state.branch}`);
      const cleanArgs = ["--branch", state.branch];
      if (keepBranch) cleanArgs.push("--keep-branch");
      if (force) cleanArgs.push("--force");
      try {
        await cmdClean(cleanArgs);
      } catch {
        // Continue on error
      }
      console.log("");
    }
    console.log(`=== All ${targets.length} ${label}sandbox(es) cleaned up ===`);
    return;
  }

  if (!branch) die("Must provide a target for clean.", [
    "<short-id>    Clean by short ID (from 'sandbox list')",
    "--all         Clean all sandboxes",
    "--stopped     Clean stopped sandboxes",
    "--missing     Clean sandboxes with missing worktrees",
    "--orphans     Clean orphaned worktree directories",
  ]);

  const sfPath = stateFilePath(branch);

  // Read state if available
  if (fs.existsSync(sfPath)) {
    const state: SandboxState = JSON.parse(fs.readFileSync(sfPath, "utf-8"));

    // Kill process if running
    if (state.pid && state.pid !== "") {
      const pid = parseInt(state.pid, 10);
      if (isProcessRunning(pid)) {
        if (!force) {
          ui.warn(`Sandbox has a running process (PID ${pid}).`);
          const answer = await promptUser("  Kill it and continue? [y/N] ");
          if (!/^[yY]$/.test(answer.trim())) {
            console.log("  Aborted.");
            return;
          }
        }
        console.log(`Stopping process ${pid}...`);
        try {
          process.kill(pid);
        } catch {
          // ignore
        }
        await sleep(2000);
        try {
          process.kill(pid, 9);
        } catch {
          // ignore
        }
      }
    }

    // Warn if audit log exists
    if (fs.existsSync(path.join(state.worktree, "audit-log.md")) && !force) {
      console.log("");
      console.log(
        "Warning: Sandbox contains an audit log (audit-log.md). This will be permanently deleted.",
      );
      const confirm = await promptUser("Continue with cleanup? [y/N] ");
      if (confirm.toLowerCase() !== "y") {
        console.log("Cleanup aborted.");
        process.exit(0);
      }
    }

    // Remove worktree directory
    if (fs.existsSync(state.worktree)) {
      console.log(`Removing worktree at ${state.worktree}...`);
      const rmResult = spawnSync(
        "git",
        ["-C", REPO_ROOT, "worktree", "remove", state.worktree, "--force"],
        { stdio: "ignore" },
      );
      if (rmResult.status !== 0) {
        // Fix permissions (e.g. root-owned vite cache) then force-remove
        spawnSync("chmod", ["-R", "u+rwX", state.worktree], {
          stdio: "ignore",
        });
        spawnSync("rm", ["-rf", state.worktree], { stdio: "ignore" });
      }
      if (fs.existsSync(state.worktree)) {
        console.warn(
          `Warning: Could not fully remove ${state.worktree} — you may need sudo rm -rf`,
        );
      }
    }

    // Remove log file
    const logFile = path.join(SANDBOX_BASE, `${state.slug}.log`);
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

    // Remove state file
    fs.unlinkSync(sfPath);
  }

  // Delete branch unless --keep-branch
  if (!keepBranch) {
    if (
      git("show-ref", "--verify", "--quiet", `refs/heads/${branch}`).status ===
      0
    ) {
      // Check if branch is still checked out in another worktree
      const wtList = git("worktree", "list", "--porcelain");
      if (wtList.stdout.includes(`branch refs/heads/${branch}`)) {
        ui.warn(`Branch '${branch}' is still checked out in another worktree. Skipping deletion.`);
        console.log("  Use --keep-branch or remove the other worktree first.");
      } else {
        console.log(`Deleting branch ${branch}...`);
        spawnSync("git", ["-C", REPO_ROOT, "branch", "-D", branch], {
          stdio: "ignore",
        });
      }
    }
  }

  // Clean up empty sandbox base dir
  if (fs.existsSync(SANDBOX_BASE)) {
    const entries = fs.readdirSync(SANDBOX_BASE);
    if (entries.length === 0) {
      try {
        fs.rmdirSync(SANDBOX_BASE);
      } catch {
        // ignore
      }
    }
  }

  console.log(`Sandbox '${branch}' cleaned up.`);
}

// --- start ---

async function cmdStart(args: string[]): Promise<void> {
  let role = "";
  let idea = "";
  let branch = "";
  let base = "master";
  let setup = false;
  let headless = false;
  let model = "opus";
  let context = "";
  let contextFile = "";
  let ralph = false;
  let maxIterations = "10";
  let skipSandbox = false;

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--role":
        role = args[++i] ?? "";
        i++;
        break;
      case "--idea":
        idea = args[++i] ?? "";
        i++;
        break;
      case "--branch":
        branch = args[++i] ?? "";
        i++;
        break;
      case "--base":
        base = args[++i] ?? "";
        i++;
        break;
      case "--setup":
        setup = true;
        i++;
        break;
      case "--headless":
        headless = true;
        i++;
        break;
      case "--model":
        model = args[++i] ?? "";
        i++;
        break;
      case "--context":
        context = args[++i] ?? "";
        i++;
        break;
      case "--context-file":
        contextFile = args[++i] ?? "";
        i++;
        break;
      case "--ralph":
        ralph = true;
        i++;
        break;
      case "--max-iterations":
        maxIterations = args[++i] ?? "10";
        i++;
        break;
      case "--skip-sandbox":
        skipSandbox = true;
        i++;
        break;
      default:
        die(`Unknown option for start: ${args[i]}`, ["Run 'sandbox --help' for usage."]);
    }
  }

  // --skip-sandbox reuses an existing sandbox — context/role already seeded
  if (!skipSandbox) {
    if (ralph) {
      if (!context && !contextFile && !idea) {
        die("Ralph mode requires --context, --context-file, or --idea");
      }
    } else {
      if (!role && !idea) die("Must provide --role or --idea");
      if (role && idea) die("Provide --role or --idea, not both");
      if (!context && !contextFile && !idea) {
        die(
          'Must provide --context or --context-file so the role has a starting point. Example:\n  sandbox start --role analyst --context "Refactor the settings service"',
        );
      }
    }
  }

  // Validate role if provided
  if (role) {
    if (!resolvePromptFile(`${role}.md`)) {
      const available = getPromptFiles()
        .map(f => path.basename(f, ".md"))
        .join(", ");
      die(`Unknown role '${role}'. Available: ${available}`);
    }
  }

  // --skip-sandbox requires an explicit branch
  if (skipSandbox && !branch) {
    die("--skip-sandbox requires --branch");
  }

  // Generate branch name if not provided
  if (!branch) {
    const hash = generateRandomHash();
    const gitUser = getGitUser();
    branch = `users/${gitUser}/worktree-${hash}`;
  }

  const SANDBOX_BASE = getSandboxBase();

  let worktreePath: string;

  if (skipSandbox) {
    // Skip sandbox creation — use existing worktree from sandbox state
    const state = readState(branch);
    worktreePath = state.worktree;
    if (!fs.existsSync(worktreePath)) {
      die(`Worktree not found for branch '${branch}': ${worktreePath}`);
    }
    console.log(`Using existing worktree: ${worktreePath}`);
  } else {
    // Create worktree
    const createArgs = ["--branch", branch, "--base", base];
    if (setup) createArgs.push("--setup");
    if (context) createArgs.push("--context", context);
    if (contextFile) createArgs.push("--context-file", contextFile);
    const created = await cmdCreate(createArgs);
    worktreePath = created.worktree;
  }

  // Seed feature-request.md if context was provided and --skip-sandbox (create handles it otherwise)
  if (skipSandbox) {
    if (context) {
      fs.writeFileSync(
        path.join(worktreePath, "feature-request.md"),
        context + "\n",
      );
      console.log("Seeded feature-request.md from --context");
    } else if (contextFile) {
      if (!fs.existsSync(contextFile))
        die(`Context file not found: ${contextFile}`);
      fs.copyFileSync(contextFile, path.join(worktreePath, "feature-request.md"));
      console.log(`Seeded feature-request.md from ${contextFile}`);
    }
  }

  // If --ralph, seed from --idea if needed and start the ralph loop
  if (ralph) {
    if (idea && !context && !contextFile) {
      fs.writeFileSync(
        path.join(worktreePath, "feature-request.md"),
        idea + "\n",
      );
      console.log("Seeded feature-request.md from --idea");
    }
    const ralphMode = headless ? "ralph-headless" : "ralph";
    writeState({
      branch,
      slug: slugFromBranch(branch),
      worktree: worktreePath,
      pid: "",
      mode: ralphMode,
      base,
      model,
      created: nowISO(),
    });
    const ralphArgs = [
      "--branch",
      branch,
      "--max-iterations",
      maxIterations,
      "--model",
      model,
    ];
    if (headless) ralphArgs.push("--headless");
    await cmdRalph(ralphArgs);
    return;
  }

  // Validate that we have enough info to launch (role or idea required)
  if (!ralph && !role && !idea) {
    die("Must provide --role or --idea for interactive mode.");
  }

  // Determine starting prompt
  let startPrompt: string;
  if (role) {
    startPrompt = `prompts/${role}.md`;
  } else {
    console.log(`Generating system prompt for idea: ${idea}`);
    const metaPrompt = `Given this idea: '${idea}', create a system prompt that defines an AI agent specialized for this task. The prompt should include:

1. A clear role definition (who the agent is)
2. Constraints and boundaries (what it should and shouldn't do)
3. Expected outputs (what files/artifacts it should produce)
4. Step-by-step methodology (how it should approach the work)
5. Rules for working in small increments with git commits

Write ONLY the system prompt content, no preamble or explanation. The prompt should be written in markdown format, starting with a heading.`;

    const genResult = spawnSync(
      "claude",
      ["-p", "--model", model, metaPrompt],
      {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    fs.writeFileSync(
      path.join(worktreePath, "prompts", "custom.md"),
      genResult.stdout ?? "",
    );
    startPrompt = "prompts/custom.md";
    console.log("Custom system prompt generated.");
  }

  const slug = slugFromBranch(branch);

  // Launch
  console.log("");
  if (headless) {
    writeState({
      branch,
      slug,
      worktree: worktreePath,
      pid: "",
      mode: "headless",
      base,
      model,
      created: nowISO(),
    });

    const logFile = path.join(SANDBOX_BASE, `${slug}.log`);
    console.log("=== Headless Mode ===");
    console.log("Launching Claude in background...");

    const headlessPrompt = role
      ? "You are starting a new session. Read the system prompt and begin your work. Look for any existing context files (requirements.md, spec.md, tasks.md) and proceed accordingly."
      : `You are starting a new session. Your task: ${idea}. Begin working on this immediately. Create small, committed increments of progress.`;

    const logFd = fs.openSync(logFile, "w");
    const env: Record<string, string | undefined> = {
      ...process.env,
      SANDBOX_DIR: worktreePath,
      PATH: `${path.join(worktreePath, "bin")}:${process.env.PATH}`,
    };
    delete env.CLAUDECODE;

    const child = spawn(
      "claude",
      [
        "-p",
        "--system-prompt-file",
        startPrompt,
        "--model",
        model,
        "--dangerously-skip-permissions",
        headlessPrompt,
      ],
      {
        cwd: worktreePath,
        env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.unref();
    fs.closeSync(logFd);

    const pid = child.pid ?? 0;
    writeState({
      branch,
      slug,
      worktree: worktreePath,
      pid: String(pid),
      mode: "headless",
      base,
      model,
      created: nowISO(),
    });

    console.log(`PID:      ${pid}`);
    console.log(`Log:      ${logFile}`);
    console.log(`Worktree: ${worktreePath}`);
    console.log("");
    console.log(`Check progress: sandbox status --branch ${branch}`);
  } else {
    writeState({
      branch,
      slug,
      worktree: worktreePath,
      pid: "",
      mode: "interactive",
      base,
      model,
      created: nowISO(),
    });

    const roleName = path.basename(startPrompt, ".md");
    console.log("=== Sandbox Ready ===");
    console.log(`Worktree: ${worktreePath}`);
    console.log(`Role:     ${roleName}`);
    console.log(`Model:    ${model}`);
    console.log("");
    console.log(
      "Switch roles anytime by exiting claude and restarting with a different prompt:",
    );
    console.log(`  cd ${worktreePath}`);
    console.log(
      '  claude --system-prompt "$(cat prompts/analyst.md)" "Begin your work. Read feature-request.md for context."',
    );
    console.log(
      '  claude --system-prompt "$(cat prompts/architect.md)" "Begin your work. Read requirements.md for context."',
    );
    console.log(
      '  claude --system-prompt "$(cat prompts/developer.md)" "Begin your work. Read spec.md for context."',
    );
    console.log(
      '  claude --system-prompt "$(cat prompts/reviewer.md)" "Begin your work. Review the latest changes against spec.md."',
    );
    console.log("");
    console.log(`Starting requested role: ${roleName}...`);
    console.log("");

    const initialPrompt = role
      ? "You are starting a new session. Read feature-request.md for context and begin your work."
      : `You are starting a new session. Your task: ${idea}. Read feature-request.md if it exists and begin your work.`;

    const promptContent = fs.readFileSync(
      path.join(worktreePath, startPrompt),
      "utf-8",
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      SANDBOX_DIR: worktreePath,
      PATH: `${path.join(worktreePath, "bin")}:${process.env.PATH}`,
    };
    delete env.CLAUDECODE;

    spawnSync(
      "claude",
      ["--system-prompt", promptContent, "--model", model, initialPrompt],
      { cwd: worktreePath, env, stdio: "inherit" },
    );
  }
}

// --- ralph ---

async function cmdRalph(args: string[]): Promise<void> {
  let branch = "";
  let maxIterations = 10;
  let model = "sonnet";
  let headless = false;
  let startWithReview = false;
  let noAgents = false;
  let composerSession = "";

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--branch":
        branch = args[++i] ?? "";
        i++;
        break;
      case "--max-iterations":
        maxIterations = parseInt(args[++i] ?? "10", 10);
        i++;
        break;
      case "--model":
        model = args[++i] ?? "";
        i++;
        break;
      case "--headless":
        headless = true;
        i++;
        break;
      case "--review":
        startWithReview = true;
        i++;
        break;
      case "--no-agents":
        noAgents = true;
        i++;
        break;
      case "--composer-session":
        composerSession = args[++i] ?? "";
        i++;
        break;
      default:
        die(`Unknown option for ralph: ${args[i]}`, ["Run 'sandbox --help' for usage."]);
    }
  }

  if (!branch) die("Must provide --branch");

  // Force no-agents mode when headless or non-TTY (agents need interactive terminal)
  if (headless || !process.stdin.isTTY) {
    noAgents = true;
  }

  const state = readState(branch);
  const worktree = state.worktree;

  if (!fs.existsSync(worktree)) die(`Worktree not found: ${worktree}`);

  // Verify developer and reviewer prompts exist
  if (!fs.existsSync(path.join(worktree, "prompts/developer.md"))) {
    die(`Missing prompts/developer.md in ${worktree}`);
  }
  if (!fs.existsSync(path.join(worktree, "prompts/reviewer.md"))) {
    die(`Missing prompts/reviewer.md in ${worktree}`);
  }

  const ignoredFile = path.join(worktree, "ignored-comments.txt");
  const ralphLog = path.join(worktree, "ralph-log.md");

  // Initialize files
  if (!fs.existsSync(ignoredFile)) fs.writeFileSync(ignoredFile, "");
  fs.writeFileSync(
    ralphLog,
    `# Ralph Loop Log\nStarted: ${nowISO()}\nBranch: ${branch}\nMax iterations: ${maxIterations}\n`,
  );

  console.log("");
  console.log("=== Ralph Loop Started ===");
  console.log(`Branch:         ${branch}`);
  console.log(`Worktree:       ${worktree}`);
  console.log(`Max iterations: ${maxIterations}`);
  console.log(`Model:          ${model}`);
  console.log("");
  console.log("Exit conditions:");
  console.log(`  - Max iterations reached (${maxIterations})`);
  console.log("  - Review is clean (no Must Fix / Should Fix)");
  if (!headless) {
    console.log(
      "  - User stops the loop (s) or ignores all remaining comments (i)",
    );
  }
  console.log("");

  let iteration = 0;
  let stop = false;

  while (iteration < maxIterations && !stop) {
    iteration++;
    console.log("=========================================");
    console.log(`  Iteration ${iteration} / ${maxIterations}`);
    console.log("=========================================");

    // --- Developer phase (skip on iteration 1 if --review) ---
    if (iteration === 1 && startWithReview) {
      console.log("");
      console.log("[dev] Skipped (--review: starting with reviewer)");
    } else {
      console.log("");
      console.log("[dev] Running developer...");

      let devInstruction: string;
      if (iteration === 1) {
        devInstruction =
          "Begin implementation. Read feature-request.md for context. If spec.md exists, follow it. Otherwise, create a plan from feature-request.md and implement it. Follow TDD. Commit after each completed task.";
      } else {
        devInstruction =
          "Read comments.md and address all items under 'Must Fix' and 'Should Fix' sections.";
        if (fs.existsSync(ignoredFile)) {
          const ignoredContent = fs.readFileSync(ignoredFile, "utf-8").trim();
          if (ignoredContent) {
            devInstruction += `\n\nIMPORTANT: The user has chosen to IGNORE the following review comments. Do NOT address these:\n${ignoredContent}`;
          }
        }
        devInstruction += "\n\nCommit your fixes when done.";
      }

      const devLog = path.join(worktree, `ralph-dev-${iteration}.log`);
      console.log(`  \x1b[2mlog: ${devLog}\x1b[0m`);

      let devResult: "done" | "stopped";
      let devSessionId: string;
      if (noAgents) {
        // Automated: -p + stream-json, agent tools disabled
        console.log(
          `  \x1b[2mcd ${worktree} && claude -p --system-prompt-file prompts/developer_single.md --model ${model} --dangerously-skip-permissions --no-agents "..."\x1b[0m`,
        );
        ({ result: devResult, sessionId: devSessionId } = await runAgentWithTimer(
          "dev",
          [
            "-p",
            "--verbose",
            "--output-format",
            "stream-json",
            "--system-prompt-file",
            "prompts/developer_single.md",
            "--model",
            model,
            "--dangerously-skip-permissions",
            "--disallowedTools",
            "Agent,TeamCreate,SendMessage",
            devInstruction,
          ],
          worktree,
          devLog,
        ));
      } else {
        // Interactive: agents enabled, tee output to log + terminal
        console.log(
          `  \x1b[2mcd ${worktree} && claude --system-prompt-file prompts/developer.md --model ${model} --dangerously-skip-permissions "..."\x1b[0m`,
        );
        ({ result: devResult, sessionId: devSessionId } = await runInteractiveAgentWithLog(
          "dev",
          [
            "--system-prompt-file",
            "prompts/developer.md",
            "--model",
            model,
            "--dangerously-skip-permissions",
            devInstruction,
          ],
          worktree,
          devLog,
        ));
      }

      if (composerSession) {
        addClaudeSession(composerSession, {
          claudeSessionId: devSessionId,
          stepIndex: -1,
          stepLabel: `ralph dev iter ${iteration}`,
          stepType: "ralph",
          projectDir: worktree,
          startedAt: new Date().toISOString(),
          ralphIteration: iteration,
          ralphPhase: "dev",
        });
      }

      generateReadableLog(devLog);

      if (devResult === "stopped") {
        console.log(
          `[dev] \u26a0 Stopped by user. (log: ralph-dev-${iteration}.log)`,
        );
        stop = true;
        continue;
      } else {
        console.log(`[dev] Done. (log: ralph-dev-${iteration}.log)`);
      }
    }

    // --- Reviewer phase ---
    console.log("");
    console.log("[rev] Running reviewer...");
    const revLog = path.join(worktree, `ralph-rev-${iteration}.log`);
    console.log(
      `  \x1b[2mcd ${worktree} && claude -p --system-prompt-file prompts/reviewer.md --model ${model} --dangerously-skip-permissions "..."\x1b[0m`,
    );
    console.log(`  \x1b[2mlog: ${revLog}\x1b[0m`);
    const { result: revResult, sessionId: revSessionId } = await runAgentWithTimer(
      "rev",
      [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--system-prompt-file",
        "prompts/reviewer.md",
        "--model",
        model,
        "--dangerously-skip-permissions",
        "Review the latest code changes. Write your findings to comments.md following the format in your system prompt.",
      ],
      worktree,
      revLog,
    );

    if (composerSession) {
      addClaudeSession(composerSession, {
        claudeSessionId: revSessionId,
        stepIndex: -1,
        stepLabel: `ralph rev iter ${iteration}`,
        stepType: "ralph",
        projectDir: worktree,
        startedAt: new Date().toISOString(),
        ralphIteration: iteration,
        ralphPhase: "rev",
      });
    }

    generateReadableLog(revLog);

    if (revResult === "stopped") {
      console.log(
        `[rev] \u26a0 Stopped by user. (log: ralph-rev-${iteration}.log)`,
      );
      stop = true;
      continue;
    } else {
      console.log(`[rev] Done. (log: ralph-rev-${iteration}.log)`);
    }

    // --- Parse comments.md ---
    console.log("");
    const commentsFile = path.join(worktree, "comments.md");
    if (!fs.existsSync(commentsFile)) {
      console.log("No comments.md produced — review complete!");
      fs.appendFileSync(
        ralphLog,
        `Iteration ${iteration}: No comments.md — DONE\n`,
      );
      break;
    }

    const allComments = parseComments(commentsFile);

    if (allComments.length === 0) {
      console.log("No Must Fix / Should Fix comments — review complete!");
      fs.appendFileSync(
        ralphLog,
        `Iteration ${iteration}: Clean review — DONE\n`,
      );
      break;
    }

    // Filter out ignored comments
    const remaining = filterIgnored(allComments, ignoredFile);

    if (remaining.length === 0) {
      console.log("All comments are in the ignore list — review complete!");
      fs.appendFileSync(
        ralphLog,
        `Iteration ${iteration}: All ignored — DONE\n`,
      );
      break;
    }

    // Display remaining comments
    console.log(`--- ${remaining.length} unresolved comment(s) ---`);
    remaining.forEach((c, idx) => {
      console.log(`  [${idx + 1}] ${c}`);
    });
    console.log("---");
    console.log("");

    fs.appendFileSync(
      ralphLog,
      `Iteration ${iteration}: ${remaining.length} unresolved\n`,
    );

    // Exit if max iterations reached
    if (iteration >= maxIterations) break;

    // In headless mode, auto-continue without prompting
    if (headless) {
      console.log("Headless mode — auto-continuing...");
      fs.appendFileSync(
        ralphLog,
        `Iteration ${iteration}: auto-continue (headless)\n`,
      );
      continue;
    }

    // Auto-advance: composer signals via file in the worktree
    const autoAdvancePath = path.join(worktree, ".ralph-auto-advance");
    if (fs.existsSync(autoAdvancePath)) {
      console.log("Auto-advance enabled — continuing...");
      fs.appendFileSync(
        ralphLog,
        `Iteration ${iteration}: auto-continue (auto-advance)\n`,
      );
      continue;
    }

    // Prompt user
    console.log("  c          Continue to next iteration");
    console.log(
      "  i <nums>   Ignore comments by number or range (e.g. 'i 1 3', 'i 1-4', 'i 1-3 5')",
    );
    console.log("  s          Stop loop (ignore reviewer)");
    console.log("");
    const userInput = await promptUser(`ralph[${iteration}]> `);

    const cmd = userInput.trim().split(/\s+/)[0] ?? "";
    switch (cmd.toLowerCase()) {
      case "c":
      case "":
        console.log("Continuing...");
        break;
      case "i": {
        const numsStr = userInput.trim().slice(1).trim();
        const expanded = expandRanges(numsStr);
        for (const num of expanded) {
          const target = remaining[num - 1];
          if (target) {
            fs.appendFileSync(ignoredFile, target + "\n");
            console.log(`  Ignored: ${target}`);
          }
        }

        // Recount after ignoring
        const newRemaining = filterIgnored(allComments, ignoredFile);
        if (newRemaining.length === 0) {
          console.log("");
          console.log("All comments ignored — review complete!");
          fs.appendFileSync(
            ralphLog,
            `Iteration ${iteration}: All ignored (user) — DONE\n`,
          );
          stop = true;
        } else {
          console.log(
            `${newRemaining.length} comment(s) remaining. Continuing...`,
          );
        }
        break;
      }
      case "s":
        console.log("Stopped by user.");
        fs.appendFileSync(
          ralphLog,
          `Iteration ${iteration}: Stopped by user\n`,
        );
        stop = true;
        break;
      default:
        console.log(`Unknown option '${cmd}', continuing...`);
        break;
    }
  }

  if (iteration >= maxIterations && !stop) {
    console.log("");
    console.log(`Reached max iterations (${maxIterations}).`);
    fs.appendFileSync(ralphLog, `Reached max iterations (${maxIterations})\n`);
  }

  console.log("");
  console.log("=== Ralph Loop Complete ===");
  console.log(`Iterations:  ${iteration}`);
  console.log(`Worktree:    ${worktree}`);
  console.log(`Log:         ${ralphLog}`);
  if (fs.existsSync(ignoredFile)) {
    const ignoredContent = fs.readFileSync(ignoredFile, "utf-8").trim();
    if (ignoredContent) {
      const ignoredCount = ignoredContent.split("\n").length;
      console.log(`Ignored:     ${ignoredCount} comment(s) in ${ignoredFile}`);
    }
  }

  // Clean up auto-advance signal file
  try { fs.unlinkSync(path.join(worktree, ".ralph-auto-advance")); } catch {}

  // Print audit summary to stdout
  generateAuditSummary(worktree);
}

// --- distill ---

async function cmdDistill(args: string[]): Promise<void> {
  let branch = "";
  let model = "sonnet";

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--branch":
        branch = args[++i] ?? "";
        i++;
        break;
      case "--model":
        model = args[++i] ?? "";
        i++;
        break;
      default:
        die(`Unknown option for distill: ${args[i]}`, ["Run 'sandbox --help' for usage."]);
    }
  }

  if (!branch) die("Must provide --branch");

  const state = readState(branch);
  const worktree = state.worktree;

  if (!fs.existsSync(worktree)) die(`Worktree not found: ${worktree}`);

  console.log(`Distilling improved feature request from ${worktree}...`);
  const content = await generateImprovedFeatureRequest(worktree, model);

  if (!content) {
    console.log(
      "Nothing to distill — requires requirements.md and spec.md in the worktree.",
    );
    return;
  }

  console.log("Generating changes summary...");
  const changesSummary = await generateFeatureRequestChangesSummary(worktree, model);
  if (changesSummary) {
    console.log("✓ Changes summary generated");
  }

  printDistillBanner(content, worktree, changesSummary);
}

// --- retro ---

async function cmdRetro(args: string[]): Promise<void> {
  let branch = "";
  let model = "sonnet";

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--branch":
        branch = args[++i] ?? "";
        i++;
        break;
      case "--model":
        model = args[++i] ?? "";
        i++;
        break;
      default:
        die(`Unknown option for retro: ${args[i]}`, ["Run 'sandbox --help' for usage."]);
    }
  }

  if (!branch) die("Must provide --branch");

  const state = readState(branch);
  const worktree = state.worktree;

  if (!fs.existsSync(worktree)) die(`Worktree not found: ${worktree}`);

  // Extract comments from all review iterations
  console.log(`Extracting review comments from ${worktree}...`);
  const allComments = extractAllComments(worktree);

  if (allComments.length === 0) {
    die("No review comments found.", [
      "This sandbox may not have run any ralph iterations yet.",
      "Comments are extracted from ralph-rev-N.log files.",
    ]);
  }

  console.log(`Found comments from ${allComments.length} iteration(s).`);
  console.log("");

  // Synthesize learnings
  console.log("Synthesizing learnings...");
  const content = await synthesizeLearnings(worktree, allComments, model);

  if (!content) {
    console.log("Failed to synthesize learnings.");
    return;
  }

  // Display
  console.log("");
  console.log("=== Retro Learnings ===");
  console.log(`Saved to: ${path.join(worktree, "retro-learnings.md")}`);
  console.log("");
  console.log(content);
  console.log("");

  // Prompt for action
  const repoRoot = getRepoRoot();
  const claudeMdPath = path.join(repoRoot, "CLAUDE.md");

  const answer = await promptUser(
    "  Action: (c)laude.md  (q)uit  > ",
  );
  const choice = answer.trim().toLowerCase();

  if (choice === "c") {
    const existing = fs.existsSync(claudeMdPath)
      ? fs.readFileSync(claudeMdPath, "utf-8")
      : "";
    fs.writeFileSync(
      claudeMdPath,
      existing + "\n\n" + content + "\n",
    );
    console.log(`  ✓ Appended to ${claudeMdPath}`);
  }
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  migrateConfigDir();
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
  sandbox — Manage isolated worktree sandboxes

  Commands:
    start <opts>       Create sandbox & launch Claude session
    ralph <opts>       Automated dev/review loop in sandbox
    list               Show all sandboxes
    size [<target>]    Show disk usage of sandbox worktrees
    status <target>    Show detailed status of a sandbox
    clean <target>     Remove sandbox (worktree, branch, state)
    roles              List available prompt roles
    create <opts>      Create a sandbox without launching Claude
    distill <opts>     Distill feature request from sandbox
    retro <opts>       Extract learnings from review iterations

  Start options:
    --role <name>        Role to run (e.g. analyst, architect, developer)
    --idea <text>        Auto-generate role from idea description
    --context <text>     Context string seeded as feature-request.md
    --context-file <f>   Read context from file
    --branch <name>      Custom branch name (default: auto-generated)
    --base <branch>      Base branch (default: master)
    --model <model>      Model to use (default: opus)
    --headless           Run without interactive terminal
    --ralph              Start in automated dev/review mode
    --max-iterations <n> Max dev/review iterations (default: 10)
    --setup              Run full yarn predev (default: symlink node_modules)
    --skip-sandbox       Reuse existing sandbox (requires --branch)

  Create options:
    --branch <name>      Custom branch name (default: auto-generated)
    --base <branch>      Base branch (default: master)
    --context <text>     Context string seeded as feature-request.md
    --context-file <f>   Read context from file
    --setup              Run full yarn predev (default: symlink node_modules)

  Ralph options:
    --branch <name>      Branch to run on (required)
    --max-iterations <n> Max iterations (default: 10)
    --model <model>      Model to use (default: opus)
    --headless           Run without interactive terminal
    --review             Start with review step instead of dev
    --no-agents          Disable agent teams (fully automated, -p mode)

  Size options:
    <short-id>           Size of a specific sandbox
    --branch <name>      Size by branch name
    (no args)            Show sizes for all sandboxes

  Status options:
    <short-id>           Lookup by short ID
    --branch <name>      Lookup by branch name
    --id <slug>          Lookup by slug

  Clean targets:
    <short-id>           Clean by short ID (from 'sandbox list')
    --branch <name>      Clean by branch name
    --all                Clean all sandboxes
    --stopped            Clean stopped sandboxes
    --missing            Clean sandboxes with missing worktrees
    --active             Clean active sandboxes
    --running            Clean running sandboxes
    --orphans            Clean orphaned worktree dirs (no state file)
    --keep-branch        Keep the git branch after cleanup
    --force              Skip confirmation prompts

  Distill options:
    --branch <name>      Branch to distill from (required)
    --model <model>      Model to use (default: sonnet)

  Retro options:
    --branch <name>      Branch to extract learnings from (required)
    --model <model>      Model to use (default: sonnet)

  Examples:
    sandbox start --role architect --context "Add caching"
    sandbox start --ralph --context "Fix login bug" --max-iterations 5
    sandbox start --idea "Add dark mode support"
    sandbox ralph --branch users/you/worktree-a1b2
    sandbox list
    sandbox status a1b2
    sandbox clean a1b2
    sandbox clean --stopped
    sandbox clean --all --force
`);
    process.exit(0);
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "create":
      await cmdCreate(rest);
      break;
    case "start":
      await cmdStart(rest);
      break;
    case "ralph":
      await cmdRalph(rest);
      break;
    case "distill":
      await cmdDistill(rest);
      break;
    case "retro":
      await cmdRetro(rest);
      break;
    case "status":
      await cmdStatus(rest);
      break;
    case "size":
      await cmdSize(rest);
      break;
    case "clean":
    case "cleanup":
      await cmdClean(rest);
      break;
    case "list":
      await cmdList();
      break;
    case "roles":
      cmdRoles();
      break;
    default:
      die(
        `Unknown command: '${command}'.`, [
          "Available: start, list, size, status, clean, ralph, create, distill, retro, roles",
          "Run 'sandbox --help' for usage.",
        ],
      );
  }
}

main();
