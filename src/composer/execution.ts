import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type {
  StepType,
  Step,
  Composition,
  SessionState,
  TemplateVars,
} from "./config/types.js";
import {
  getSandboxScript,
  getPrScript,
  getSandboxStateDirPath,
  COMPOSITIONS,
} from "./config/compositions.js";
import { die, promptUser, writeState, setCurrentSession } from "./state.js";
import { HAS_TMUX, IN_TMUX, runInTmux, waitForTmuxOrSkip } from "./tmux.js";
import {
  generateFeatureRequestChangesSummary,
  generateImprovedFeatureRequest,
  printDistillBanner,
} from "../sandbox/distill.js";
import { parseComments, filterIgnored } from "../sandbox/ralph-helpers.js";
import { deterministicSessionId } from "../metrics/uuid.js";
import { addClaudeSession } from "../metrics/session-map.js";
import * as ui from "./ui.js";

// ── Temp file tracking ──────────────────────────────────────
const trackedTmpFiles = new Set<string>();

export function cleanupAllTempFiles(): void {
  for (const f of trackedTmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }
  trackedTmpFiles.clear();
}

function trackTmpFile(filePath: string): void {
  trackedTmpFiles.add(filePath);
}

function untrackTmpFile(filePath: string): void {
  trackedTmpFiles.delete(filePath);
}

// ── Template resolution ─────────────────────────────────────

export function resolveTemplate(
  cmd: string,
  vars: TemplateVars,
): { resolved: string; tmpFile?: string } {
  let tmpFile: string | undefined;
  let resolved = cmd
    .replace(/\{sandbox\}/g, getSandboxScript())
    .replace(/\{pr_script\}/g, getPrScript())
    .replace(/\{session_id\}/g, vars.sessionId)
    .replace(/\{branch_name\}/g, vars.branchName)
    .replace(/\{branch\}/g, vars.branch)
    .replace(/\{worktree\}/g, vars.worktree)
    .replace(/\{model\}/g, vars.model)
    .replace(/\{max_iterations\}/g, String(vars.maxIterations))
    .replace(/\{ado_id\}/g, vars.adoId)
    .replace(/\{role\}/g, vars.role)
    .replace(/\{base_branch\}/g, vars.baseBranch)
    .replace(/\{claude_session_id\}/g, vars.claudeSessionId ?? "");

  // Write context to a temp file instead of inlining it into the shell command.
  // ADO/markdown content contains quotes, $, backticks, etc. that break bash parsing.
  if (resolved.includes("{context}")) {
    tmpFile = path.join(
      os.tmpdir(),
      `composer-ctx-${process.pid}-${Date.now()}.md`,
    );
    fs.writeFileSync(tmpFile, vars.context, "utf-8");
    trackTmpFile(tmpFile);
    resolved = resolved.replace(
      /--context\s+["']\{context\}["']/,
      `--context-file "${tmpFile}"`,
    );
    // Remove any remaining {context} references (shouldn't happen, but be safe)
    resolved = resolved.replace(/\{context\}/g, "");
  }

  return { resolved, tmpFile };
}

// ── Sandbox info capture ────────────────────────────────────

function captureSandboxInfo(
  branchName: string,
): { branch: string; worktree: string } | null {
  const sandboxStateDir = getSandboxStateDirPath();
  if (!fs.existsSync(sandboxStateDir)) return null;

  const files = fs
    .readdirSync(sandboxStateDir)
    .filter(f => f.endsWith(".json"));

  if (files.length === 0) return null;

  // Match by branch name first to avoid picking up a concurrent session's state
  if (branchName) {
    for (const f of files) {
      const state = JSON.parse(
        fs.readFileSync(path.join(sandboxStateDir, f), "utf-8"),
      );
      if (state.branch === branchName && state.worktree) {
        return { branch: state.branch, worktree: state.worktree };
      }
    }
  }

  // Fallback: most recently modified file (single-session compat)
  const sorted = files
    .map(f => ({
      name: f,
      mtime: fs.statSync(path.join(sandboxStateDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const state = JSON.parse(
    fs.readFileSync(path.join(sandboxStateDir, sorted[0].name), "utf-8"),
  );
  if (state.branch && state.worktree) {
    return { branch: state.branch, worktree: state.worktree };
  }
  return null;
}

function resolveWorktreeFromBranch(branch: string): string | null {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout) return null;

  const blocks = result.stdout.split("\n\n");
  for (const block of blocks) {
    if (block.includes(`branch refs/heads/${branch}`)) {
      const match = block.match(/^worktree\s+(.+)$/m);
      if (match) return match[1];
    }
  }
  return null;
}

// ── Pre-step checks ─────────────────────────────────────────

async function preCheckStep(
  stepType: StepType,
  vars: TemplateVars,
): Promise<boolean> {
  // Check worktree exists for non-start steps
  const startTypes: StepType[] = [
    "sandbox-create",
    "sandbox-start",
  ];

  if (
    !startTypes.includes(stepType) &&
    vars.worktree &&
    !fs.existsSync(vars.worktree)
  ) {
    ui.errorBlock("Worktree directory missing", `Expected: ${vars.worktree}`, [
      "The worktree may have been deleted since this session was created.",
      "Re-run the sandbox creation step (press 'p') or start fresh with 'composer clean'.",
    ]);
    return false;
  }

  // Warn if PR step has no commits
  if (stepType === "ado-pr-create" || stepType === "pr-dry-run") {
    if (vars.worktree && fs.existsSync(vars.worktree)) {
      const result = spawnSync(
        "git",
        ["-C", vars.worktree, "log", "--oneline", "origin/master..HEAD"],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const commits = (result.stdout ?? "").trim();
      if (!commits) {
        ui.warn(
          "No commits found on this branch. PR step may produce empty results.",
        );
        const answer = await promptUser("  Continue anyway? [y/N] ");
        if (!/^[yY]$/.test(answer)) return false;
      }
    }
  }

  // Verify branch/worktree are set for steps that need them
  if (!startTypes.includes(stepType)) {
    if (!vars.branch || !vars.worktree) {
      ui.errorBlock(
        "Branch/worktree not captured yet",
        "The sandbox creation step may not have completed successfully.",
        [
          "Use 'p' to go back and re-run the sandbox creation step.",
          "Use 'q' to quit and investigate.",
        ],
      );
      return false;
    }
  }

  return true;
}

// ── Execution helpers ───────────────────────────────────────

function runInline(cmd: string): number {
  const result = spawnSync("bash", ["-c", cmd], { stdio: "inherit" });
  return result.status ?? 1;
}

function cleanupTmpFile(tmpFile?: string): void {
  if (tmpFile) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
    untrackTmpFile(tmpFile);
  }
}

// ── Step suggestions by type ────────────────────────────────

export function stepFailSuggestions(stepType: StepType, exitCode: number): string[] {
  const common = [`Step exited with code ${exitCode}.`];
  switch (stepType) {
    case "sandbox-create":
    case "sandbox-start":
      return [
        ...common,
        "Check that the sandbox script exists and is executable.",
        "Verify 'az login' session is active.",
        "Retry with 'n' or quit with 'q'.",
      ];
    case "claude-interactive":
    case "ralph":
      return [
        ...common,
        "Check Claude API key / model availability.",
        "Review the worktree for conflicting state.",
        "Retry with 'n' or skip with 's'.",
      ];
    case "pr-dry-run":
    case "ado-pr-create":
      return [
        ...common,
        "Verify the branch has commits (git log origin/master..HEAD).",
        "Check ADO / git remote connectivity.",
        "Retry with 'n' or skip with 's'.",
      ];
    default:
      return [...common, "Retry with 'n', skip with 's', or quit with 'q'."];
  }
}

// ── Retry configuration ─────────────────────────────────────

const RETRYABLE_TYPES: Set<StepType> = new Set([
  "sandbox-create",
  "sandbox-start",
  "claude-interactive",
  "ralph",
]);
const MAX_RETRIES = 2;
const RETRY_BACKOFF = [5, 10]; // seconds

// ── Resolve step command (public) ───────────────────────────

export function resolveStepCommand(
  step: Step,
  vars: TemplateVars,
): { resolved: string; tmpFile?: string } {
  return resolveTemplate(step.cmd, vars);
}

// ── Execute step ────────────────────────────────────────────

async function executeStep(
  step: Step,
  stepIndex: number,
  vars: TemplateVars,
  state: SessionState,
  preResolved?: { resolved: string; tmpFile?: string },
): Promise<number> {
  const { resolved: resolvedCmd, tmpFile } = preResolved ?? resolveTemplate(step.cmd, vars);

  // Pre-step validation
  const ok = await preCheckStep(step.type, vars);
  if (!ok) {
    cleanupTmpFile(tmpFile);
    return 1;
  }

  // Re-execution warning (skip for autoAdvance steps — they should never prompt)
  if (state.stepTimings[stepIndex] > 0 && !step.autoAdvance) {
    ui.warn(
      `This step was previously run (${ui.formatElapsed(state.stepTimings[stepIndex])}). ` +
        "Re-running may not be idempotent.",
    );
    const answer = await promptUser("  Continue? [Y/n] ");
    if (/^[nN]$/.test(answer)) return 1;
  }

  const t0 = Date.now();

  const startTypes: StepType[] = [
    "sandbox-create",
    "sandbox-start",
  ];

  // Sandbox-start/create steps always run inline (need to capture branch/worktree)
  if (startTypes.includes(step.type)) {
    const exitCode = runInline(resolvedCmd);
    const elapsed = Date.now() - t0;
    state.stepTimings[stepIndex] = elapsed;

    if (exitCode === 0) {
      const info = captureSandboxInfo(vars.branchName);
      if (info) {
        vars.branch = info.branch;
        vars.worktree = info.worktree;
        state.branch = info.branch;
        state.worktree = info.worktree;
      } else {
        ui.warn("Could not capture sandbox info from state files.");
        const manualBranch = await promptUser(
          "  Enter branch name manually, or press Enter to skip: ",
        );
        if (manualBranch.trim()) {
          vars.branch = manualBranch.trim();
          state.branch = manualBranch.trim();
          const wt = resolveWorktreeFromBranch(manualBranch.trim());
          if (wt) {
            vars.worktree = wt;
            state.worktree = wt;
            console.log(`  ${ui.green("✓")} Resolved worktree: ${wt}`);
          } else {
            ui.warn("Could not resolve worktree from branch name.");
          }
        }
      }
      writeState(state);
    }

    cleanupTmpFile(tmpFile);
    return exitCode;
  }

  // Preview/info steps always run inline so output stays visible in the terminal
  const inlineOnlyTypes: StepType[] = ["pr-dry-run", "status-check"];

  // Tmux mode
  if (IN_TMUX && HAS_TMUX && !inlineOnlyTypes.includes(step.type)) {
    const handle = runInTmux(resolvedCmd);
    const rc = waitForTmuxOrSkip(handle, vars.worktree || undefined);
    const elapsed = Date.now() - t0;
    state.stepTimings[stepIndex] = elapsed;
    cleanupTmpFile(tmpFile);
    return rc;
  }

  // Inline fallback
  const rc = runInline(resolvedCmd);
  const elapsed = Date.now() - t0;
  state.stepTimings[stepIndex] = elapsed;
  cleanupTmpFile(tmpFile);
  return rc;
}

// ── Status display ──────────────────────────────────────────

export function showStatus(
  state: SessionState,
  composition: Composition,
  skippedSteps?: Set<number>,
): void {
  ui.banner(`Status: ${state.composition}`, [
    ["Session", state.sessionId],
    ["Model", state.model],
    ["Branch", state.branch || ui.dim("<pending>")],
    ["Worktree", state.worktree || ui.dim("<pending>")],
  ]);
  ui.pipeline(composition.steps, state.currentStep, state.stepTimings, skippedSteps);
}

// ── Post-ralph comment check ─────────────────────────────────

async function checkPendingComments(
  vars: TemplateVars,
  state: SessionState,
): Promise<boolean> {
  const commentsFile = path.join(vars.worktree, "comments.md");
  const ignoredFile = path.join(vars.worktree, "ignored-comments.txt");

  if (!fs.existsSync(commentsFile)) return false;

  const allComments = parseComments(commentsFile);
  const remaining = filterIgnored(allComments, ignoredFile);

  if (remaining.length === 0) return false;

  console.log(`\n  ${ui.yellow("⚠")} ${ui.bold(`${remaining.length} unresolved review comment(s) after ralph loop:`)}`);
  remaining.forEach((c, idx) => {
    console.log(`    ${ui.dim(`${idx + 1}.`)} ${c}`);
  });
  console.log("");
  console.log(`  ${ui.cyan("r <n>")}   Re-run ralph for n iterations (e.g. 'r 3')`);
  console.log(`  ${ui.cyan("c")}       Continue to PR step anyway`);
  console.log("");

  const input = await promptUser("  Action> ");
  const trimmed = input.trim().toLowerCase();

  if (trimmed.startsWith("r")) {
    const nStr = trimmed.slice(1).trim();
    const n = parseInt(nStr, 10);
    if (!n || n < 1) {
      console.log(`  ${ui.red("Invalid iteration count.")} Continuing to PR.`);
      return false;
    }
    state.maxIterations = n;
    vars.maxIterations = n;
    console.log(`  ${ui.green("↻")} Re-running ralph with ${n} iteration(s)...`);
    return true;
  }

  return false;
}

// ── Main composition loop ───────────────────────────────────

export async function runComposition(state: SessionState): Promise<void> {
  const rawComposition = COMPOSITIONS[state.composition];
  if (!rawComposition) die(`Unknown composition type '${state.composition}'`);

  setCurrentSession(state);

  const vars: TemplateVars = {
    sessionId: state.sessionId,
    context: state.context,
    branchName: state.branch || "",
    branch: state.branch,
    worktree: state.worktree,
    model: state.model,
    maxIterations: state.maxIterations,
    adoId: state.adoId,
    role: state.role || "",
    baseBranch: state.baseBranch || "master",
  };

  // Resolve {role} placeholders in step labels so pipeline/status display correctly
  const resolveLabel = (l: string) => l.replace(/\{role\}/g, vars.role || "role");
  const composition: Composition = {
    ...rawComposition,
    steps: rawComposition.steps.map(s => ({ ...s, label: resolveLabel(s.label) })),
  };

  let currentStep = state.currentStep;
  let hasPrompted = false; // Track whether user has seen a manual prompt
  let failedAutoAdvance = false; // Set when autoAdvance step exhausts retries

  // Track steps skipped by --skip-sandbox for pipeline display
  const skippedSteps = new Set<number>();
  if (state.skipSandbox) {
    skippedSteps.add(0);
  }

  while (currentStep < state.totalSteps) {
    const step = composition.steps[currentStep];

    // Show pipeline instead of progress bar
    ui.stepHeader(currentStep + 1, state.totalSteps, step.label);
    ui.pipeline(composition.steps, currentStep, state.stepTimings, skippedSteps);

    // Generate deterministic Claude session ID for interactive steps
    if (step.type === "claude-interactive") {
      const csId = deterministicSessionId(state.sessionId, currentStep);
      vars.claudeSessionId = csId;
    }

    // Show resolved command before prompt
    const preResolved = resolveStepCommand(step, vars);
    console.log(`\n  ${ui.dim("Command:")} ${ui.dim(preResolved.resolved)}\n`);

    // Auto-advance steps proceed immediately; first human-facing step uses
    // manual prompt; subsequent steps use countdown auto-run.
    // failedAutoAdvance is set when an autoAdvance step exhausted retries —
    // forces a manual prompt so the user can decide how to proceed.
    let cmd: string;
    if (step.autoAdvance && !failedAutoAdvance) {
      cmd = "n";
    } else if (!hasPrompted) {
      hasPrompted = true;
      ui.keyHints();
      const input = await promptUser(
        `\ncomposer[${currentStep + 1}/${state.totalSteps}]> `,
      );
      cmd = (input || "n").trim().toLowerCase();
    } else {
      ui.keyHintsAutoRun();
      cmd = await ui.countdown(10);
    }

    switch (cmd) {
      case "n": {
        state.currentStep = currentStep;
        state.status = "in_progress";
        writeState(state);

        let rc = await executeStep(step, currentStep, vars, state, preResolved);

        // Auto-retry for transient failures
        if (rc !== 0 && rc !== 2 && RETRYABLE_TYPES.has(step.type)) {
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const backoff = RETRY_BACKOFF[attempt - 1] ?? 10;
            ui.stepResult(false, `${step.label} failed (exit code ${rc})`);
            const shouldRetry = await ui.retryCountdown(backoff, attempt, MAX_RETRIES);
            if (!shouldRetry) break;
            console.log(`  ${ui.cyan("↻")} Retrying ${step.label}...`);
            const retryResolved = resolveStepCommand(step, vars);
            rc = await executeStep(step, currentStep, vars, state, retryResolved);
            if (rc === 0 || rc === 2) break;
          }
        }

        if (rc === 0) {
          failedAutoAdvance = false;
          currentStep++;
          state.currentStep = currentStep;
          writeState(state);

          // Record claude-interactive sessions in durable map
          if (step.type === "claude-interactive" && vars.claudeSessionId) {
            addClaudeSession(state.sessionId, {
              claudeSessionId: vars.claudeSessionId,
              stepIndex: currentStep - 1,
              stepLabel: step.label,
              stepType: step.type,
              projectDir: vars.worktree,
              startedAt: new Date().toISOString(),
            });
          }

          // Named step result
          ui.stepResult(
            true,
            `${step.label} completed`,
            state.stepTimings[currentStep - 1],
          );

          // After ralph, check for unresolved comments before advancing to PR
          if (step.type === "ralph" && vars.worktree) {
            const shouldRerun = await checkPendingComments(vars, state);
            if (shouldRerun) {
              // Re-run ralph step instead of advancing
              currentStep--;
              state.currentStep = currentStep;
              writeState(state);
              hasPrompted = false;
            }
          }

          // Auto-distill after claude-interactive steps (architect phase)
          if (step.type === "claude-interactive" && vars.worktree) {
            await tryDistillImprovedFeatureRequest(vars.worktree, vars.model);
          }
        } else if (rc === 2) {
          currentStep++;
          state.currentStep = currentStep;
          writeState(state);
          ui.stepResult(true, `${step.label} skipped`);
        } else {
          // Named failure message
          ui.stepResult(false, `${step.label} failed (exit code ${rc})`);
          ui.errorBlock(
            `${step.label} failed`,
            undefined,
            stepFailSuggestions(step.type, rc),
          );
          // After failure, show manual prompt on next iteration so user can
          // decide how to proceed (retry/skip/quit) instead of auto-countdown
          hasPrompted = false;
          if (step.autoAdvance) failedAutoAdvance = true;
        }
        break;
      }

      case "p": {
        cleanupTmpFile(preResolved.tmpFile);
        const minStep = state.skipSandbox ? 1 : 0;
        if (currentStep > minStep) {
          currentStep--;
          state.currentStep = currentStep;
          writeState(state);
          console.log(`  Moved back to step ${currentStep + 1}.`);
        } else {
          console.log("  Already at the first step.");
        }
        break;
      }

      case "s": {
        cleanupTmpFile(preResolved.tmpFile);
        currentStep++;
        state.currentStep = currentStep;
        writeState(state);
        ui.stepResult(true, `${step.label} skipped`);
        break;
      }

      case "q": {
        cleanupTmpFile(preResolved.tmpFile);
        state.currentStep = currentStep;
        state.status = "paused";
        writeState(state);
        const shortId = state.sessionId.slice(-4);
        console.log(`\n  Composition paused at step ${currentStep + 1}.\n  Resume with: ${ui.cyan(`composer resume ${shortId}`)}`);
        setCurrentSession(null);
        process.exit(0);
        break; // unreachable, but satisfies no-fallthrough lint
      }

      case "?":
      case "status": {
        cleanupTmpFile(preResolved.tmpFile);
        showStatus(state, composition, skippedSteps);
        break;
      }

      default:
        cleanupTmpFile(preResolved.tmpFile);
        console.log(`  Unknown command: ${cmd}`);
    }
  }

  // Completion banner
  const totalElapsed = state.stepTimings.reduce((a, b) => a + b, 0);
  const fields: [string, string][] = [
    ["Type", state.composition],
    ["Session", state.sessionId],
    ["Branch", state.branch || ui.dim("<none>")],
    ["Worktree", state.worktree || ui.dim("<none>")],
  ];
  if (totalElapsed > 0) {
    fields.push(["Total", ui.formatElapsed(totalElapsed)]);
  }
  ui.banner(ui.green("Composition Complete"), fields);

  // Per-step timing breakdown
  ui.pipeline(composition.steps, state.totalSteps, state.stepTimings, skippedSteps);

  state.status = "completed";
  writeState(state);
  setCurrentSession(null);
}

async function tryDistillImprovedFeatureRequest(
  worktree: string,
  model: string,
): Promise<void> {
  const reqPath = path.join(worktree, "requirements.md");
  const specPath = path.join(worktree, "spec.md");

  if (!fs.existsSync(reqPath) || !fs.existsSync(specPath)) {
    return;
  }

  console.log(`\n  ${ui.yellow("⚗")}  ${ui.yellow("Auto-distilling improved feature request...")}\n  ${ui.dim("   Sending feature-request.md + requirements.md + spec.md to Claude")}`);

  const content = await generateImprovedFeatureRequest(worktree, model);

  if (content) {
    console.log(`  ${ui.green("✓")} Distillation complete`);

    console.log(`  ${ui.dim("   Generating changes summary...")}`);
    const changesSummary = await generateFeatureRequestChangesSummary(
      worktree,
      model,
    );
    if (changesSummary) {
      console.log(`  ${ui.green("✓")} Changes summary generated`);
    }

    printDistillBanner(content, worktree, changesSummary);
  } else {
    console.log(`  ${ui.dim("✗ Distillation skipped")}`);
  }
}
