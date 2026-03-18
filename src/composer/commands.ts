import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { SessionState } from "./config/types.js";
import {
  COMPOSITIONS,
  getRepoRoot,
  getSandboxStateDirPath,
} from "./config/compositions.js";
import {
  getComposerStateDir,
  getAllPromptFiles,
  resolvePromptFile,
  PACKAGE_ROOT,
} from "../shared/paths.js";
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
import { fetchAdoItem } from "../connectors/ado-work-item/fetch.js";
import { resolveAdoOrg } from "../shared/config.js";
import { promptUser } from "../shared/utils.js";
import {
  generateImprovedFeatureRequest,
  generateImplementationFeatureRequest,
  generateFeatureRequestChangesSummary,
  printDistillBanner,
} from "../sandbox/distill.js";
import * as ui from "./ui.js";
import {
  createSessionMap,
  loadSessionMap,
  listAllSessionMaps,
  claudeProjectDirPaths,
} from "../metrics/session-map.js";
import type { ComposerSessionMap } from "../metrics/types.js";

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
  return getAllPromptFiles().map((f) => path.basename(f, ".md"));
}

export function getAvailableCompositions(): string[] {
  return Object.keys(COMPOSITIONS);
}

/** Turn free-text context into a short kebab-case slug for branch names. */
export function slugifyContext(text: string): string {
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
  const compLines = Object.entries(COMPOSITIONS).map(([name, comp]) => {
    const padded = name.padEnd(15);
    return `  ${ui.cyan(padded)} ${comp.description} ${ui.dim(`(${comp.steps.length} steps)`)}`;
  });
  console.log(
    [
      ui.bold("Available compositions:"),
      "",
      ...compLines,
      "",
      ui.bold("Usage:"),
      '  composer compose <type> --context "..." | --context-file <path> | --ado <id>',
      "",
      ui.bold("Options:"),
      "  --model <model>         Model to use (default: opus)",
      "  --max-iterations <n>    Max dev/review iterations (default: 5)",
      "  --role <name>           Role to run (required for 'role' composition)",
      "  --name <session-name>   Custom session name (auto-deduped if taken)",
      "  --base <branch>         Base branch for sandbox worktree (default: master)",
      "  --skip-sandbox          Skip sandbox creation, run on current branch",
      "",
      "Run 'composer --help' for full usage details.",
    ].join("\n"),
  );
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
  let skipSandbox = false;
  let baseBranch = "master";

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
      case "--base":
        baseBranch = args[++i] ?? "master";
        break;
      case "--skip-sandbox":
        skipSandbox = true;
        break;
      default:
        die(`Unknown option '${args[i]}'.`, [
          "Run 'composer compose --help' or 'composer --help' for usage.",
        ]);
    }
    i++;
  }

  // Validate --skip-sandbox compatibility
  if (skipSandbox && compType === "headless") {
    die("--skip-sandbox is not compatible with the 'headless' composition.", [
      "Headless mode requires a sandbox worktree to manage the background process.",
      "Run without --skip-sandbox, or use a different composition type.",
    ]);
  }

  // Validate --role usage
  if (compType === "role") {
    if (!role) {
      die("The 'role' composition requires --role <name>.", [
        `Available roles: ${getAvailableRoles().join(", ")}`,
        'Example: composer compose role --role architect --context "..."',
      ]);
    }
    if (!resolvePromptFile(`${role}.md`)) {
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
    const adoOrg = await resolveAdoOrg();
    try {
      context = fetchAdoItem(adoId, adoOrg);
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

    console.log(
      `\n=== ADO Work Item Context ===\n\n${context}\n\n=============================`,
    );
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
    baseBranch,
    skipSandbox: skipSandbox || undefined,
    stepTimings: [],
    started: nowISO(),
    updated: nowISO(),
  };

  // --skip-sandbox: skip sandbox creation step, run on current branch
  if (skipSandbox) {
    const repoRoot = getRepoRoot();
    const currentBranch =
      spawnSync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).stdout?.trim() || "";

    if (!currentBranch) {
      die("Could not determine current git branch for --skip-sandbox.");
    }

    state.currentStep = 1; // skip step 0 (sandbox-create)
    state.branch = currentBranch;
    state.worktree = repoRoot;

    // Seed feature-request.md in current directory if context was provided
    if (context) {
      fs.writeFileSync(
        path.join(repoRoot, "feature-request.md"),
        context + "\n",
      );
    }
  }

  writeState(state);
  createSessionMap(sessionId, compType, state.branch);

  ui.banner(`Composer: ${compType}`, [
    ["Session", sessionId],
    ["Steps", String(composition.steps.length)],
    ["Model", model],
    ["Max iterations", String(maxIterations)],
    ["Execution", IN_TMUX && HAS_TMUX ? "tmux windows" : "inline (no tmux)"],
  ]);

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

  const displayIds = sessions.map((s) => truncateId(s.sessionId));
  const idWidth = Math.max(4, ...displayIds.map((id) => id.length)) + 2;
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
      toRemove = sessions.filter((s) => s.status === "completed");
      needsConfirmation = true;
      break;
    case "--stale":
      toRemove = sessions.filter(
        (s) => s.status === "completed" || s.status === "paused",
      );
      needsConfirmation = true;
      break;
    default: {
      // Treat as session ID (supports short IDs) — no confirmation needed
      const resolved = resolveSessionId(flag);
      toRemove = sessions.filter((s) => s.sessionId === resolved);
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

  const repoRoot = getRepoRoot();
  const sandboxBin = path.join(PACKAGE_ROOT, "dist", "bin", "sandbox.js");

  for (const s of toRemove) {
    // Clean the associated sandbox (worktree, branch, sandbox state) if a branch exists
    if (s.branch) {
      console.log(`  Cleaning sandbox for ${s.branch}...`);
      const result = spawnSync(
        "node",
        [sandboxBin, "clean", "--branch", s.branch, "--force"],
        { cwd: repoRoot, stdio: "inherit" },
      );
      if (result.status !== 0) {
        ui.warn(
          `Sandbox cleanup failed for ${s.branch} (may already be gone).`,
        );
      }
    }
    deleteSession(s.sessionId);
    console.log(`  Removed: ${s.sessionId} (${s.composition}, ${s.status})`);
  }
  console.log(`\nCleaned ${toRemove.length} session(s).`);
}

export async function cmdReport(args: string[]): Promise<void> {
  let sessionId = "";
  let format: "json" | "text" | "html" = "html";
  let outPath: string | null = null;

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--json":
        format = "json";
        i++;
        break;
      case "--text":
        format = "text";
        i++;
        break;
      case "--html":
        format = "html";
        i++;
        break;
      case "--out":
        outPath = args[++i] ?? "";
        i++;
        break;
      default:
        if (!sessionId && !args[i].startsWith("-")) {
          sessionId = args[i];
          i++;
        } else {
          die(`Unknown option '${args[i]}'.`, [
            "Usage: composer report [session-id] [--json|--text|--html] [--out <path>]",
          ]);
        }
    }
  }

  // If no session specified, list all and prompt
  if (!sessionId) {
    const allMaps = listAllSessionMaps();
    if (allMaps.length === 0) {
      die("No tracked composer sessions found.", [
        "Session tracking is enabled for new compositions.",
        "Run 'composer compose ...' to start a tracked session.",
      ]);
    }

    // Sort most recent first
    allMaps.sort((a, b) => {
      const ta = new Date(a.startedAt).getTime() || 0;
      const tb = new Date(b.startedAt).getTime() || 0;
      return tb - ta;
    });

    console.log(ui.bold("Tracked composer sessions:\n"));
    for (let idx = 0; idx < allMaps.length; idx++) {
      const m = allMaps[idx];
      const sessions = m.claudeSessions.length;
      const date = m.startedAt ? ui.relativeTime(m.startedAt) : "—";
      console.log(
        `  ${ui.cyan(String(idx + 1).padStart(2))}  ${m.composerSessionId.slice(0, 30).padEnd(32)} ${m.compositionType.padEnd(12)} ${String(sessions).padEnd(4)} sessions  ${date}`,
      );
    }
    console.log("");

    const answer = await promptUser(`  Select session [1-${allMaps.length}]: `);
    const selected = parseInt(answer.trim(), 10);
    if (isNaN(selected) || selected < 1 || selected > allMaps.length) {
      console.log("  Aborted.");
      return;
    }
    sessionId = allMaps[selected - 1].composerSessionId;
  }

  // Resolve partial session ID
  const allMaps = listAllSessionMaps();
  const match = allMaps.find(
    (m) =>
      m.composerSessionId === sessionId ||
      m.composerSessionId.endsWith(sessionId) ||
      m.composerSessionId.startsWith(sessionId),
  );

  if (!match) {
    die(`No session map found for '${sessionId}'.`, [
      "The session may predate metrics tracking.",
      "Run 'composer report' without args to see all tracked sessions.",
    ]);
  }

  const map: ComposerSessionMap = match;

  if (map.claudeSessions.length === 0) {
    die("No Claude sessions recorded for this composer session.", [
      "The composition may not have reached any Claude steps yet.",
    ]);
  }

  // Lazy import to avoid loading the large analyzer module unless needed
  const { parseSession, printSessionMetrics, generateHtmlReport } =
    await import("../metrics/session-metrics.js");

  // Collect and parse all session files
  type ParsedEntry = {
    label: string;
    metrics: ReturnType<typeof parseSession>;
  };
  const parsed: ParsedEntry[] = [];

  for (const entry of map.claudeSessions) {
    const dirs = claudeProjectDirPaths(entry.projectDir);
    let found = false;
    for (const dir of dirs) {
      const filePath = path.join(dir, `${entry.claudeSessionId}.jsonl`);
      if (fs.existsSync(filePath)) {
        const metrics = parseSession(filePath);
        // Enrich with composer context
        metrics.sessionId = entry.claudeSessionId;
        metrics.summary = entry.stepLabel;
        if (entry.ralphIteration) {
          metrics.summary += ` (iter ${entry.ralphIteration}, ${entry.ralphPhase})`;
        }
        parsed.push({ label: entry.stepLabel, metrics });
        found = true;
        break;
      }
    }
    if (!found) {
      ui.warn(
        `Session file not found for ${entry.claudeSessionId.slice(0, 8)}... (${entry.stepLabel})`,
      );
    }
  }

  if (parsed.length === 0) {
    die("No session files could be found on disk.", [
      "The worktree may have been deleted.",
      "Check that ~/.claude/projects/ contains the session .jsonl files.",
    ]);
  }

  const allMetrics = parsed.map((p) => p.metrics);

  // Output
  if (format === "json") {
    console.log(
      JSON.stringify({ composerSession: map, metrics: allMetrics }, null, 2),
    );
  } else if (format === "text") {
    ui.banner(`Report: ${map.compositionType}`, [
      ["Session", map.composerSessionId],
      ["Branch", map.branch],
      ["Claude sessions", String(parsed.length)],
    ]);
    for (const p of parsed) {
      printSessionMetrics(p.metrics);
    }
  } else {
    const html = generateHtmlReport(allMetrics);
    const os = await import("node:os");
    const { execSync } = await import("node:child_process");
    const out =
      outPath ??
      path.join(
        os.tmpdir(),
        `composer-report-${map.composerSessionId.slice(0, 12)}.html`,
      );
    fs.writeFileSync(out, html);
    console.log(`\n  Report written to ${out}`);
    try {
      execSync(`open "${out}"`);
    } catch {
      // non-macOS or open not available
    }
  }
}

export async function cmdDistill(args: string[]): Promise<void> {
  let sessionId = "";
  let model = "sonnet";
  let fromImpl = false;
  let baseBranch = "";

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--model":
        model = args[++i] ?? "sonnet";
        break;
      case "--from-impl":
        fromImpl = true;
        break;
      case "--base":
        baseBranch = args[++i] ?? "master";
        break;
      default:
        if (!sessionId && !args[i].startsWith("-")) {
          sessionId = args[i];
        } else {
          die(`Unknown option '${args[i]}'.`, [
            "Usage: composer distill [session-id] [--model <model>] [--from-impl] [--base <branch>]",
          ]);
        }
    }
    i++;
  }

  // If no session specified, pick the most recent one with a worktree
  if (!sessionId) {
    const sessions = listStateSessions()
      .filter((s) => s.worktree)
      .sort((a, b) => {
        const ta = new Date(a.updated || a.started || "").getTime() || 0;
        const tb = new Date(b.updated || b.started || "").getTime() || 0;
        return tb - ta;
      });

    if (sessions.length === 0) {
      die("No sessions with a worktree found.", [
        "Run 'composer sessions' to see available sessions.",
        "Provide a session ID: composer distill <session-id>",
      ]);
    }
    sessionId = sessions[0].sessionId;
    console.log(`  Using most recent session: ${ui.cyan(sessionId)}`);
  }

  const state = readState(sessionId);

  if (!state.worktree) {
    die(`Session '${sessionId}' has no worktree.`, [
      "The sandbox creation step may not have completed.",
      "Run 'composer sessions' to check session state.",
    ]);
  }

  if (!fs.existsSync(state.worktree)) {
    die(`Worktree not found: ${state.worktree}`, [
      "The worktree may have been deleted.",
      "Run 'composer clean' to remove stale sessions.",
    ]);
  }

  if (fromImpl) {
    console.log(
      `\n  ${ui.yellow("⚗")}  ${ui.yellow("Distilling feature request from implementation...")}` +
        `\n  ${ui.dim("   Reading code diff + planning artifacts in " + state.worktree)}`,
    );

    const content = await generateImplementationFeatureRequest(
      state.worktree,
      model,
      baseBranch || state.baseBranch || "master",
    );

    if (!content) {
      console.log(
        "  Nothing to distill — no code changes found on this branch.",
      );
      return;
    }

    console.log(`  ${ui.green("✓")} Implementation feature request generated`);
    console.log("");
    console.log("=== Implementation Feature Request ===");
    console.log(
      `Saved to: ${path.join(state.worktree, "implementation-feature-request.md")}`,
    );
    console.log("");
    console.log("To reuse in a fresh sandbox:");
    console.log(
      `  sandbox start --ralph --context-file ${path.join(state.worktree, "implementation-feature-request.md")}`,
    );
    console.log("");
    console.log("--- Content ---");
    console.log(content);
    console.log("---");
  } else {
    console.log(
      `\n  ${ui.yellow("⚗")}  ${ui.yellow("Distilling improved feature request...")}` +
        `\n  ${ui.dim("   Sending feature-request.md + requirements.md + spec.md to Claude")}`,
    );

    const content = await generateImprovedFeatureRequest(state.worktree, model);

    if (!content) {
      console.log(
        "  Nothing to distill — requires requirements.md and spec.md in the worktree.",
      );
      return;
    }

    console.log(`  ${ui.green("✓")} Distillation complete`);

    console.log(`  ${ui.dim("   Generating changes summary...")}`);
    const changesSummary = await generateFeatureRequestChangesSummary(
      state.worktree,
      model,
    );
    if (changesSummary) {
      console.log(`  ${ui.green("✓")} Changes summary generated`);
    }

    printDistillBanner(content, state.worktree, changesSummary);
  }
}
