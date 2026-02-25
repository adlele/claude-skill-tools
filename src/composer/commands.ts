import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { SessionState } from "./config/types.js";
import {
  COMPOSITIONS,
  getRepoRoot,
  getSandboxScript,
  getSandboxStateDirPath,
} from "./config/compositions.js";
import { getComposerStateDir, PROMPTS_DIR } from "../shared/paths.js";
import {
  die,
  nowISO,
  writeState,
  readState,
  resolveSessionId,
  listStateSessions,
  deleteSession,
} from "./state.js";
import { runComposition } from "./execution.js";
import { HAS_TMUX, IN_TMUX } from "./tmux.js";
import { fetchAdoItem } from "../ado-bug-context/fetch-ado-item.js";
import { promptUser } from "../shared/utils.js";
import * as ui from "./ui.js";

function getGitUser(): string {
  const repoRoot = getRepoRoot();
  const result = spawnSync("git", ["-C", repoRoot, "config", "user.name"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const name = (result.stdout ?? "").trim();
  return name ? name.toLowerCase().replace(/[ ]/g, "-") : "sandbox";
}

function getAvailableRoles(): string[] {
  if (!fs.existsSync(PROMPTS_DIR)) return [];
  return fs
    .readdirSync(PROMPTS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => f.replace(/\.md$/, ""));
}

function getAvailableCompositions(): string[] {
  return Object.keys(COMPOSITIONS);
}

/** Turn free-text context into a short kebab-case slug for branch names. */
function slugifyContext(text: string): string {
  return text
    .replace(/^#\s*/, "") // strip leading markdown heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // strip non-alphanumeric
    .trim()
    .replace(/\s+/g, "-") // spaces to dashes
    .replace(/-+/g, "-") // collapse multiple dashes
    .slice(0, 40) // cap length
    .replace(/-$/, ""); // trim trailing dash
}

/**
 * Given a desired session name, check if it already exists.
 * If so, append an incrementing digit: name1, name2, name3, ...
 * Strips any existing trailing digits first so "copy1" doesn't become "copy11".
 */
function resolveUniqueSessionName(name: string): string {
  const stateDir = getComposerStateDir();
  const sessionExists = (id: string) =>
    fs.existsSync(path.join(stateDir, `${id}.json`));

  if (!sessionExists(name)) return name;

  // Strip trailing digits to find the base: "copy1" → "copy", "copy" → "copy"
  const base = name.replace(/\d+$/, "");
  let n = 1;
  while (sessionExists(`${base}${n}`)) {
    n++;
  }
  const resolved = `${base}${n}`;
  ui.warn(`Session '${name}' already exists — using '${resolved}' instead.`);
  return resolved;
}

export function cmdList(): void {
  console.log(ui.bold("Available compositions:"));
  console.log("");
  for (const [name, comp] of Object.entries(COMPOSITIONS)) {
    const padded = name.padEnd(15);
    console.log(
      `  ${ui.cyan(padded)} ${comp.description} ${ui.dim(`(${comp.steps.length} steps)`)}`,
    );
  }
  console.log("");
  console.log(ui.bold("Usage:"));
  console.log(
    '  composer compose <type> --context "..." | --context-file <path> | --ado <id>',
  );
  console.log("");
  console.log(ui.bold("Options:"));
  console.log("  --model <model>         Model to use (default: opus)");
  console.log(
    "  --max-iterations <n>    Max dev/review iterations (default: 5)",
  );
  console.log(
    "  --role <name>           Role to run (required for 'role' composition)",
  );
  console.log(
    "  --name <session-name>   Custom session name (auto-deduped if taken)",
  );
  console.log("");
  console.log("Run 'composer --help' for full usage details.");
}

export async function cmdCompose(args: string[]): Promise<void> {
  if (args.length === 0) {
    die("Missing composition type.", [
      "Run 'composer list' to see available types.",
      "Example: composer compose full --ado 12345",
      'Example: composer compose role --role architect --context "..."',
    ]);
  }

  const compType = args[0];
  if (!COMPOSITIONS[compType]) {
    die(`Unknown composition type '${compType}'.`, [
      `Available types: ${getAvailableCompositions().join(", ")}`,
      "Run 'composer list' for descriptions.",
    ]);
  }

  let context = "";
  let contextFile = "";
  let adoId = "";
  let model = "opus";
  let maxIterations = 5;
  let role = "";
  let sessionName = "";

  let i = 1;
  while (i < args.length) {
    switch (args[i]) {
      case "--context":
        context = args[++i] ?? "";
        break;
      case "--context-file":
        contextFile = args[++i] ?? "";
        break;
      case "--ado":
        adoId = args[++i] ?? "";
        break;
      case "--model":
        model = args[++i] ?? "opus";
        break;
      case "--max-iterations":
        maxIterations = parseInt(args[++i] ?? "5", 10);
        break;
      case "--role":
        role = args[++i] ?? "";
        break;
      case "--name":
        sessionName = args[++i] ?? "";
        break;
      default:
        die(`Unknown option '${args[i]}'.`, [
          "Run 'composer compose --help' or 'composer --help' for usage.",
        ]);
    }
    i++;
  }

  // Validate --role usage
  if (compType === "role") {
    if (!role) {
      die("The 'role' composition requires --role <name>.", [
        `Available roles: ${getAvailableRoles().join(", ")}`,
        'Example: composer compose role --role architect --context "..."',
      ]);
    }
    const promptFile = path.join(PROMPTS_DIR, `${role}.md`);
    if (!fs.existsSync(promptFile)) {
      die(`Unknown role '${role}'.`, [
        `Available roles: ${getAvailableRoles().join(", ")}`,
      ]);
    }
  } else if (role) {
    die(`--role is only valid with the 'role' composition type.`, [
      `Use 'composer compose role --role ${role} ...' instead.`,
    ]);
  }

  if (!context && !contextFile && !adoId) {
    die("Missing context. Provide one of the following:", [
      '--context "description of the task"',
      "--context-file <path>",
      "--ado <work-item-id>",
    ]);
  }

  // Fetch from ADO if specified
  if (adoId) {
    try {
      context = fetchAdoItem(adoId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.errorBlock("Failed to fetch ADO work item", msg, [
        "Check that you're logged in: run 'az login'.",
        `Verify the work item ID is correct: ${adoId}`,
        "Check network connectivity to Azure DevOps.",
      ]);
      const manual = await promptUser(
        "  Enter context manually (or press Enter to abort): ",
      );
      if (!manual.trim()) {
        console.log("Aborted.");
        process.exit(1);
      }
      context = manual.trim();
    }

    console.log("");
    console.log("=== ADO Work Item Context ===");
    console.log("");
    console.log(context);
    console.log("");
    console.log("=============================");
    const answer = await promptUser("Proceed with this context? (y/n) ");
    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  // Load context from file if specified (skip if already populated from ADO)
  if (contextFile && !context) {
    if (!fs.existsSync(contextFile)) {
      die(`Context file not found: ${contextFile}`, [
        "Check the file path and try again.",
      ]);
    }
    context = fs.readFileSync(contextFile, "utf-8");
  }

  // Generate session ID: use --name if provided, otherwise auto-generate from context
  let sessionId: string;
  if (sessionName) {
    sessionId = resolveUniqueSessionName(sessionName);
  } else {
    const hash = randomBytes(2).toString("hex");
    const slug = slugifyContext(context);
    sessionId = slug ? `${slug}-${hash}` : hash;
  }
  const gitUser = getGitUser();
  const branchName = `users/${gitUser}/${sessionId}`;

  const composition = COMPOSITIONS[compType];

  const state: SessionState = {
    sessionId,
    composition: compType,
    currentStep: 0,
    totalSteps: composition.steps.length,
    status: "in_progress",
    context,
    model,
    maxIterations,
    branch: branchName,
    worktree: "",
    adoId,
    role: role || undefined,
    stepTimings: [],
    started: nowISO(),
    updated: nowISO(),
  };

  writeState(state);

  ui.banner(`Composer: ${compType}`, [
    ["Session", sessionId],
    ["Steps", String(composition.steps.length)],
    ["Model", model],
    ["Max iterations", String(maxIterations)],
    ["Execution", IN_TMUX && HAS_TMUX ? "tmux windows" : "inline (no tmux)"],
  ]);
  console.log("");

  await runComposition(state);
}

export async function cmdResume(args: string[]): Promise<void> {
  if (args.length === 0) {
    die("Missing session ID.", [
      "Run 'composer sessions' to see available sessions.",
      "Example: composer resume a1b2",
    ]);
  }

  const sessionId = args[0];
  const state = readState(sessionId);

  if (state.status !== "paused" && state.status !== "in_progress") {
    die(`Session '${sessionId}' is not resumable (status: ${state.status}).`, [
      "Only paused or in-progress sessions can be resumed.",
      "Run 'composer sessions' to check session statuses.",
    ]);
  }

  // Validate worktree still exists
  if (state.worktree && !fs.existsSync(state.worktree)) {
    ui.warn(`Worktree directory no longer exists: ${state.worktree}`);
    const answer = await promptUser(
      "  Continue anyway (worktree steps will fail)? [y/N] ",
    );
    if (!/^[yY]$/.test(answer)) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  ui.banner(`Resuming: ${state.composition}`, [
    ["Session", state.sessionId],
    ["Step", `${state.currentStep + 1} / ${state.totalSteps}`],
    ["Branch", state.branch || ui.dim("<pending>")],
    ["Worktree", state.worktree || ui.dim("<pending>")],
  ]);
  console.log("");

  await runComposition(state);
}

export function cmdSessions(): void {
  const sessions = listStateSessions();

  if (sessions.length === 0) {
    console.log("No composer sessions found.");
    return;
  }

  // Sort most-recent first
  sessions.sort((a, b) => {
    const ta = new Date(a.updated || a.started || "").getTime() || 0;
    const tb = new Date(b.updated || b.started || "").getTime() || 0;
    return tb - ta;
  });

  // Truncate long IDs: keep first 20 + "…" + last 4
  const truncateId = (id: string, max: number = 28): string => {
    if (id.length <= max) return id;
    return id.slice(0, max - 5) + "…" + id.slice(-4);
  };

  const displayIds = sessions.map(s => truncateId(s.sessionId));
  const idWidth = Math.max(4, ...displayIds.map(id => id.length)) + 2;
  const updatedWidth = 10;

  const header = [
    "ID".padEnd(idWidth),
    "TYPE".padEnd(15),
    "STATUS".padEnd(12),
    "STEP".padEnd(8),
    "UPDATED".padEnd(updatedWidth),
    "BRANCH",
  ].join(" ");
  const divider = [
    "─".repeat(idWidth),
    "─".repeat(15),
    "─".repeat(12),
    "─".repeat(8),
    "─".repeat(updatedWidth),
    "──────",
  ].join(" ");

  console.log(header);
  console.log(divider);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const step = `${s.currentStep + 1}/${s.totalSteps}`;
    const badge = ui.statusBadge(s.status);
    const ansiOverhead = badge.length - s.status.length;
    // Relative timestamp
    const updated = s.updated ? ui.relativeTime(s.updated) : ui.dim("—");
    const updatedAnsiOverhead = s.updated ? 0 : updated.length - "—".length;
    console.log(
      [
        displayIds[i].padEnd(idWidth),
        s.composition.padEnd(15),
        badge.padEnd(12 + ansiOverhead),
        step.padEnd(8),
        updated.padEnd(updatedWidth + updatedAnsiOverhead),
        s.branch || "<pending>",
      ].join(" "),
    );
  }
}

export async function cmdClean(args: string[]): Promise<void> {
  if (args.length === 0) {
    die("Missing target for clean.", [
      "<session-id>   Remove a specific session",
      "--all          Remove all sessions",
      "--completed    Remove completed sessions",
      "--stale        Remove completed and paused sessions",
    ]);
  }

  const flag = args[0];
  const sessions = listStateSessions();

  if (sessions.length === 0) {
    console.log("No sessions to clean.");
    return;
  }

  let toRemove: SessionState[];
  let needsConfirmation = false;

  switch (flag) {
    case "--all":
      toRemove = sessions;
      needsConfirmation = true;
      break;
    case "--completed":
      toRemove = sessions.filter(s => s.status === "completed");
      needsConfirmation = true;
      break;
    case "--stale":
      toRemove = sessions.filter(
        s => s.status === "completed" || s.status === "paused",
      );
      needsConfirmation = true;
      break;
    default: {
      // Treat as session ID (supports short IDs) — no confirmation needed
      const resolved = resolveSessionId(flag);
      toRemove = sessions.filter(s => s.sessionId === resolved);
    }
  }

  if (toRemove.length === 0) {
    console.log("No matching sessions to remove.");
    return;
  }

  // Confirmation for bulk deletions
  if (needsConfirmation) {
    const answer = await promptUser(
      `  Remove ${toRemove.length} session(s)? [y/N] `,
    );
    if (!/^[yY]$/.test(answer.trim())) {
      console.log("  Aborted.");
      return;
    }
  }

  for (const s of toRemove) {
    deleteSession(s.sessionId);
    console.log(`  Removed: ${s.sessionId} (${s.composition}, ${s.status})`);
  }
  console.log(`\nCleaned ${toRemove.length} session(s).`);
}
