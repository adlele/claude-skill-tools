// sandbox.ts — Manage isolated git worktree sandboxes for Claude Code
// Usage: sandbox <create|start|ralph|distill|status|cleanup|list|roles> [options]

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync, spawn } from "node:child_process";

import { die, nowISO, promptUser, sleep } from "../shared/utils.js";
import { resolveRepoRoot, PROMPTS_DIR } from "../shared/paths.js";
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
} from "./config/paths.js";
import { generateAuditSummary } from "./audit.js";
import {
  expandRanges,
  parseComments,
  filterIgnored,
  runAgentWithTimer,
  generateReadableLog,
} from "./ralph-helpers.js";
import {
  generateFeatureRequestChangesSummary,
  generateImprovedFeatureRequest,
  printDistillBanner,
} from "./distill.js";

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

// --- list ---

function cmdList(): void {
  const jsonFiles = getStateFiles();

  if (jsonFiles.length === 0) {
    console.log("No sandboxes found.");
    return;
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    `${pad("ID", 20)} ${pad("BRANCH", 35)} ${pad("MODE", 12)} ${pad("STATUS", 8)} WORKTREE`,
  );
  console.log(
    `${pad("--", 20)} ${pad("------", 35)} ${pad("----", 12)} ${pad("------", 8)} --------`,
  );

  let found = false;
  for (const f of jsonFiles) {
    found = true;
    const state: SandboxState = JSON.parse(fs.readFileSync(f, "utf-8"));

    let status = "ACTIVE";
    if (!fs.existsSync(state.worktree)) {
      status = "MISSING";
    } else if (state.mode === "headless" && state.pid && state.pid !== "") {
      const pid = parseInt(state.pid, 10);
      status = isProcessRunning(pid) ? "RUNNING" : "STOPPED";
    }

    console.log(
      `${pad(state.slug, 20)} ${pad(state.branch, 35)} ${pad(state.mode, 12)} ${pad(status, 8)} ${state.worktree}`,
    );
  }

  if (!found) console.log("No sandboxes found.");
}

// --- status ---

function cmdStatus(args: string[]): void {
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
        die(`Unknown option for status: ${args[i]}`);
    }
  }

  if (id && !branch) {
    branch = resolveBranchFromId(id);
  }

  if (!branch) {
    cmdList();
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
      default:
        die(`Unknown option for create: ${args[i]}`);
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
      worktreePath,
      `origin/${base}`,
      "--quiet",
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (wtResult.status !== 0) {
    die(`Failed to create worktree: ${wtResult.stderr?.trim()}`);
  }

  // Optional setup
  if (setup) {
    console.log("Running yarn predev in worktree...");
    spawnSync("yarn", ["predev"], { cwd: worktreePath, stdio: "inherit" });
  }

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
    "ralph-*.log",
    "ralph-log.md",
    "ignored-comments.txt",
    "feature-request.md",
    "audit-raw.jsonl",
    "audit-log.md",
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

async function cmdCleanup(args: string[]): Promise<void> {
  let branch = "";
  let id = "";
  let keepBranch = false;
  let force = false;
  let all = false;

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
      default:
        die(`Unknown option for cleanup: ${args[i]}`);
    }
  }

  const REPO_ROOT = getRepoRoot();
  const SANDBOX_BASE = getSandboxBase();

  // Resolve --id to a branch name
  if (id && !branch) {
    branch = resolveBranchFromId(id);
  }

  // --all: iterate over all known sandboxes and clean each one
  if (all) {
    const jsonFiles = getStateFiles();
    if (jsonFiles.length === 0) {
      console.log("No sandboxes to clean up.");
      return;
    }
    const total = jsonFiles.length;
    console.log(`=== Cleaning up ${total} sandbox(es) ===`);
    console.log("");
    for (let idx = 0; idx < jsonFiles.length; idx++) {
      const state: SandboxState = JSON.parse(
        fs.readFileSync(jsonFiles[idx], "utf-8"),
      );
      console.log(`[${idx + 1}/${total}] ${state.branch}`);
      const cleanupArgs = ["--branch", state.branch];
      if (keepBranch) cleanupArgs.push("--keep-branch");
      if (force) cleanupArgs.push("--force");
      try {
        await cmdCleanup(cleanupArgs);
      } catch {
        // Continue on error
      }
      console.log("");
    }
    console.log(`=== All ${total} sandbox(es) cleaned up ===`);
    return;
  }

  if (!branch) die("Must provide --branch, --id, or --all");

  const sfPath = stateFilePath(branch);

  // Read state if available
  if (fs.existsSync(sfPath)) {
    const state: SandboxState = JSON.parse(fs.readFileSync(sfPath, "utf-8"));

    // Kill process if running
    if (state.pid && state.pid !== "") {
      const pid = parseInt(state.pid, 10);
      if (isProcessRunning(pid)) {
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
      console.log(`Deleting branch ${branch}...`);
      spawnSync("git", ["-C", REPO_ROOT, "branch", "-D", branch], {
        stdio: "ignore",
      });
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
      default:
        die(`Unknown option for start: ${args[i]}`);
    }
  }

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

  // Validate role if provided
  if (role) {
    const promptFile = path.join(PROMPTS_DIR, `${role}.md`);
    if (!fs.existsSync(promptFile)) {
      const available = getPromptFiles()
        .map(f => path.basename(f, ".md"))
        .join(", ");
      die(`Unknown role '${role}'. Available: ${available}`);
    }
  }

  // Generate branch name if not provided
  if (!branch) {
    const hash = generateRandomHash();
    const gitUser = getGitUser();
    branch = `users/${gitUser}/worktree-${hash}`;
  }

  const SANDBOX_BASE = getSandboxBase();

  // Create worktree
  const createArgs = ["--branch", branch, "--base", base];
  if (setup) createArgs.push("--setup");
  const created = await cmdCreate(createArgs);
  const worktreePath = created.worktree;

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
    const env = { ...process.env, SANDBOX_DIR: worktreePath };
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
    const env = { ...process.env, SANDBOX_DIR: worktreePath };
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
      default:
        die(`Unknown option for ralph: ${args[i]}`);
    }
  }

  if (!branch) die("Must provide --branch");

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
      console.log(
        `  \x1b[2mcd ${worktree} && claude -p --system-prompt-file prompts/developer.md --model ${model} --dangerously-skip-permissions "..."\x1b[0m`,
      );
      console.log(`  \x1b[2mlog: ${devLog}\x1b[0m`);
      const devResult = await runAgentWithTimer(
        "dev",
        [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          "--system-prompt-file",
          "prompts/developer.md",
          "--model",
          model,
          "--dangerously-skip-permissions",
          devInstruction,
        ],
        worktree,
        devLog,
      );

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
    const revResult = await runAgentWithTimer(
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
        die(`Unknown option for distill: ${args[i]}`);
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

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    die(
      "Usage: sandbox <create|start|ralph|distill|status|cleanup|list|roles> [options]",
    );
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
    case "status":
      cmdStatus(rest);
      break;
    case "cleanup":
      await cmdCleanup(rest);
      break;
    case "list":
      cmdList();
      break;
    case "roles":
      cmdRoles();
      break;
    default:
      die(
        `Unknown command: ${command}. Use: create, start, ralph, distill, status, cleanup, list, roles`,
      );
  }
}

main();
