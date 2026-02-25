// composer.ts — Orchestrate sandbox workflow compositions
// Usage: composer <list|compose|resume|sessions> [options]

import {
  cmdList,
  cmdCompose,
  cmdResume,
  cmdSessions,
  cmdClean,
} from "./commands.js";
import { currentSession, writeState, listStateSessions } from "./state.js";
import { cleanupAllTempFiles } from "./execution.js";
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

  console.log("");
  console.log(ui.dim(`  ╔${"═".repeat(w)}╗`));
  console.log(ui.dim(`  ║`) + " ".repeat(w) + ui.dim(`║`));
  for (const line of logo) {
    const vis = line.length;
    const right = w - vis;
    console.log(
      ui.dim(`  ║`) +
        ui.bold(ui.cyan(line)) +
        " ".repeat(Math.max(0, right)) +
        ui.dim(`║`),
    );
  }
  console.log(ui.dim(`  ║`) + " ".repeat(w) + ui.dim(`║`));
  console.log(ui.dim(`  ║`) + pad(ui.dim(subtitle), w) + ui.dim(`║`));
  console.log(ui.dim(`  ║`) + " ".repeat(w) + ui.dim(`║`));
  console.log(ui.dim(`  ╚${"═".repeat(w)}╝`));
  console.log("");

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

  // Quick start
  console.log(ui.bold("  Quick start:"));
  console.log(
    `    ${ui.cyan("composer compose full --ado 12345")}        ${ui.dim("Full workflow from ADO item")}`,
  );
  console.log(
    `    ${ui.cyan('composer compose ralph-only --context "..."')} ${ui.dim("Automated dev/review")}`,
  );
  console.log(
    `    ${ui.cyan("composer compose role --role architect")}    ${ui.dim("Single role session")}`,
  );
  console.log("");

  // Commands
  console.log(ui.bold("  Commands:"));
  console.log(
    `    ${ui.cyan("compose")} <type> [opts]   Start a new composition`,
  );
  console.log(
    `    ${ui.cyan("resume")} <session-id>     Resume a paused session`,
  );
  console.log(`    ${ui.cyan("sessions")}                Show all sessions`);
  console.log(
    `    ${ui.cyan("list")}                    List composition types`,
  );
  console.log(`    ${ui.cyan("clean")} <target>          Remove session state`);
  console.log(`    ${ui.cyan("--help")}                  Full usage details`);
  console.log("");
}

// ── Full help ───────────────────────────────────────────────

function printHelp(): void {
  console.log(
    `${ui.bold("composer")} — Orchestrate sandbox workflow compositions`,
  );
  console.log("");
  console.log(`${ui.bold("Usage:")} composer <command> [options]`);
  console.log("");
  console.log(`${ui.bold("Commands:")}`);
  console.log(
    `  list                                 List available composition types`,
  );
  console.log(
    `  compose <type> [options]              Start a new composition`,
  );
  console.log(
    `  resume <session-id>                   Resume a paused/in-progress session`,
  );
  console.log(
    `  sessions                              Show all composer sessions`,
  );
  console.log(`  clean <id|--all|--completed|--stale>  Remove session state`);
  console.log("");
  console.log(`${ui.bold("Compose options:")}`);
  console.log(`  --context "..."                       Inline context string`);
  console.log(
    `  --context-file <path>                 Read context from a file`,
  );
  console.log(
    `  --ado <work-item-id>                  Fetch context from Azure DevOps`,
  );
  console.log(
    `  --model <model>                       Model to use (default: opus)`,
  );
  console.log(
    `  --max-iterations <n>                  Max dev/review iterations (default: 5)`,
  );
  console.log(
    `  --role <name>                         Role to run (required for 'role' composition)`,
  );
  console.log(
    `  --name <session-name>                 Use a custom session name instead of auto-generated`,
  );
  console.log(
    `  --no-tmux                             Don't auto-launch in a tmux window`,
  );
  console.log("");
  console.log(`${ui.bold("Composition types:")}`);
  console.log(
    `  full          analyst → architect → ralph (dev/review loop) → PR`,
  );
  console.log(`  ralph-only    sandbox → ralph (automated dev/review) → PR`);
  console.log(
    `  manual        analyst → architect → developer → reviewer → PR`,
  );
  console.log(
    `  role          sandbox → single role session → PR  ${ui.dim("(requires --role)")}`,
  );
  console.log(`  headless      background developer → status check → PR`);
  console.log("");
  console.log(`${ui.bold("Examples:")}`);
  console.log(`  composer list`);
  console.log(`  composer compose full --ado 12345`);
  console.log(`  composer compose ralph-only --context "Fix the login button"`);
  console.log(
    `  composer compose role --role architect --context "Design caching layer"`,
  );
  console.log(`  composer compose full --ado 12345 --name my-feature`);
  console.log(`  composer resume a1b2`);
  console.log(`  composer clean --completed`);
}

function installSignalHandlers(): void {
  const handler = (signal: string) => {
    console.log("");
    if (currentSession) {
      currentSession.status = "paused";
      writeState(currentSession);
      console.log("");
      ui.warn(`Caught ${signal} — saving session state.`);
      const shortId = currentSession.sessionId.slice(-4);
      console.log(
        `  Session ${currentSession.sessionId} paused at step ${currentSession.currentStep + 1}.`,
      );
      console.log(
        `  Resume with: ${ui.cyan(`composer resume ${shortId}`)}`,
      );
    }
    cleanupAllTempFiles();
    process.exit(130);
  };

  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

async function main(): Promise<void> {
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
    default:
      console.error("");
      console.error(
        `  ${ui.red(ui.bold("ERROR:"))} Unknown command '${command}'.`,
      );
      console.error("");
      console.error(`  ${ui.yellow("Suggestions:")}`);
      console.error(
        `    ${ui.yellow("1.")} Available commands: list, compose, resume, sessions, clean`,
      );
      console.error(
        `    ${ui.yellow("2.")} Run 'composer --help' for full usage.`,
      );
      console.error("");
      process.exit(1);
  }
}

main();
