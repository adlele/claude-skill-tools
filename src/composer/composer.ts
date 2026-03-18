// composer.ts — Orchestrate sandbox workflow compositions
// Usage: composer <list|compose|resume|sessions> [options]

import {
  cmdList,
  cmdCompose,
  cmdResume,
  cmdSessions,
  cmdClean,
  cmdReport,
  cmdDistill,
} from "./commands.js";
import { currentSession, writeState, listStateSessions } from "./state.js";
import { cleanupAllTempFiles } from "./execution.js";
import { migrateConfigDir } from "../shared/paths.js";
import * as ui from "./ui.js";

// ── Welcome screen ──────────────────────────────────────────

function printWelcome(): void {
  const w = 56;
  const pad = (s: string, len: number) => {
    const vis = ui.stripAnsi(s).length;
    const left = Math.floor((len - vis) / 2);
    const right = len - vis - left;
    return " ".repeat(left) + s + " ".repeat(right);
  };

  const logo = [
    `       ___                                          `,
    `      / __\\___  _ __ ___  _ __   ___  ___  ___ _ __ `,
    `     / /  / _ \\| '_ \` _ \\| '_ \\ / _ \\/ __|/ _ \\ '__|`,
    `    / /__| (_) | | | | | | |_) | (_) \\__ \\  __/ |   `,
    `    \\____/\\___/|_| |_| |_| .__/ \\___/|___/\\___|_|   `,
    `                         |_|                        `,
  ];

  const subtitle = `Orchestrate sandbox workflow compositions`;

  const boxLines = [
    "",
    ui.dim(`  ╔${"═".repeat(w)}╗`),
    ui.dim(`  ║`) + " ".repeat(w) + ui.dim(`║`),
    ...logo.map(line => {
      const right = w - line.length;
      return ui.dim(`  ║`) + ui.bold(ui.cyan(line)) + " ".repeat(Math.max(0, right)) + ui.dim(`║`);
    }),
    ui.dim(`  ║`) + " ".repeat(w) + ui.dim(`║`),
    ui.dim(`  ║`) + pad(ui.dim(subtitle), w) + ui.dim(`║`),
    ui.dim(`  ║`) + " ".repeat(w) + ui.dim(`║`),
    ui.dim(`  ╚${"═".repeat(w)}╝`),
    "",
  ];
  console.log(boxLines.join("\n"));

  // Show active sessions summary
  const sessions = listStateSessions();
  const inProgress = sessions.filter(s => s.status === "in_progress");
  const paused = sessions.filter(s => s.status === "paused");

  if (inProgress.length > 0 || paused.length > 0) {
    const parts: string[] = [];
    if (inProgress.length > 0)
      parts.push(ui.cyan(`${inProgress.length} active`));
    if (paused.length > 0) parts.push(ui.yellow(`${paused.length} paused`));
    console.log(`  ${ui.bold("Sessions:")} ${parts.join(ui.dim(" · "))}`);

    // Show most recent resumable session
    const resumable = [...paused, ...inProgress].sort((a, b) => {
      const ta = new Date(a.updated || a.started || "").getTime() || 0;
      const tb = new Date(b.updated || b.started || "").getTime() || 0;
      return tb - ta;
    });
    if (resumable.length > 0) {
      const s = resumable[0];
      const shortId = s.sessionId.slice(-4);
      const step = `step ${s.currentStep + 1}/${s.totalSteps}`;
      const ago = ui.relativeTime(s.updated || s.started);
      console.log(
        `  ${ui.dim("Resume latest:")} ${ui.cyan(`composer resume ${shortId}`)} ${ui.dim(`(${s.composition}, ${step}, ${ago})`)}`,
      );
    }
    console.log("");
  }

  console.log([
    ui.bold("  Quick start:"),
    `    ${ui.cyan("composer compose full --ado 12345")}        ${ui.dim("Full workflow from ADO item")}`,
    `    ${ui.cyan('composer compose ralph-only --context "..."')} ${ui.dim("Automated dev/review")}`,
    `    ${ui.cyan("composer compose role --role architect")}    ${ui.dim("Single role session")}`,
    "",
    ui.bold("  Commands:"),
    `    ${ui.cyan("compose")} <type> [opts]   Start a new composition`,
    `    ${ui.cyan("resume")} <session-id>     Resume a paused session`,
    `    ${ui.cyan("sessions")}                Show all sessions`,
    `    ${ui.cyan("list")}                    List composition types`,
    `    ${ui.cyan("clean")} <target>          Remove session state`,
    `    ${ui.cyan("report")} [session-id]    Generate metrics report for a session`,
    `    ${ui.cyan("distill")} [session-id]   Distill feature request from session artifacts`,
    `    ${ui.cyan("--help")}                  Full usage details`,
    "",
  ].join("\n"));
}

// ── Full help ───────────────────────────────────────────────

function printHelp(): void {
  console.log([
    `${ui.bold("composer")} — Orchestrate sandbox workflow compositions`,
    "",
    `${ui.bold("Usage:")} composer <command> [options]`,
    "",
    ui.bold("Commands:"),
    `  list                                 List available composition types`,
    `  compose <type> [options]              Start a new composition`,
    `  resume <session-id>                   Resume a paused/in-progress session`,
    `  sessions                              Show all composer sessions`,
    `  clean <id|--all|--completed|--stale>  Remove session state`,
    `  report [session-id] [--json|--text]   Generate metrics report`,
    `  distill [session-id] [options]        Distill feature request from artifacts`,
    "",
    ui.bold("Compose options:"),
    `  --context "..."                       Inline context string`,
    `  --context-file <path>                 Read context from a file`,
    `  --ado <work-item-id>                  Fetch context from Azure DevOps`,
    `  --model <model>                       Model to use (default: opus)`,
    `  --max-iterations <n>                  Max dev/review iterations (default: 5)`,
    `  --role <name>                         Role to run (required for 'role' composition)`,
    `  --name <session-name>                 Use a custom session name instead of auto-generated`,
    `  --skip-sandbox                        Skip sandbox creation, run on current branch`,
    "",
    ui.bold("Distill options:"),
    `  --model <model>                       Model to use (default: sonnet)`,
    `  --from-impl                           Generate from actual implementation (code diff)`,
    "",
    ui.bold("Composition types:"),
    `  full          analyst → architect → ralph (dev/review loop) → PR`,
    `  ralph-only    sandbox → ralph (automated dev/review) → PR`,
    `  manual        analyst → architect → developer → reviewer → PR`,
    `  role          sandbox → single role session → PR  ${ui.dim("(requires --role)")}`,
    `  headless      background developer → status check → PR`,
    "",
    ui.bold("Examples:"),
    `  composer list`,
    `  composer compose full --ado 12345`,
    `  composer compose ralph-only --context "Fix the login button"`,
    `  composer compose role --role architect --context "Design caching layer"`,
    `  composer compose full --ado 12345 --name my-feature`,
    `  composer resume a1b2`,
    `  composer clean --completed`,
    `  composer distill                                        ${ui.dim("# distill latest session")}`,
    `  composer distill a1b2 --from-impl                      ${ui.dim("# from actual code changes")}`,
  ].join("\n"));
}

function installSignalHandlers(): void {
  const handler = (signal: string) => {
    if (currentSession) {
      currentSession.status = "paused";
      writeState(currentSession);
      const shortId = currentSession.sessionId.slice(-4);
      console.log(`\n\n${ui.yellow("⚠")} Caught ${signal} — saving session state.\n  Session ${currentSession.sessionId} paused at step ${currentSession.currentStep + 1}.\n  Resume with: ${ui.cyan(`composer resume ${shortId}`)}`);
    }
    cleanupAllTempFiles();
    process.exit(130);
  };

  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

async function main(): Promise<void> {
  migrateConfigDir();
  installSignalHandlers();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    printWelcome();
    process.exit(0);
  }

  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "list":
      cmdList();
      break;
    case "compose":
      await cmdCompose(rest);
      break;
    case "resume":
      await cmdResume(rest);
      break;
    case "sessions":
      cmdSessions();
      break;
    case "clean":
      await cmdClean(rest);
      break;
    case "report":
      await cmdReport(rest);
      break;
    case "distill":
      await cmdDistill(rest);
      break;
    default:
      console.error([
        "",
        `  ${ui.red(ui.bold("ERROR:"))} Unknown command '${command}'.`,
        "",
        `  ${ui.yellow("Suggestions:")}`,
        `    ${ui.yellow("1.")} Available commands: list, compose, resume, sessions, clean, report, distill`,
        `    ${ui.yellow("2.")} Run 'composer --help' for full usage.`,
        "",
      ].join("\n"));
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("Could not find a git repository")) {
    console.error([
      "",
      `  ${ui.red(ui.bold("ERROR:"))} Not a git repository.`,
      "",
      `  Composer must be run from within a git repository.`,
      `  ${ui.dim("cd into your project directory and try again.")}`,
      "",
    ].join("\n"));
    process.exit(1);
  }
  throw err;
});
