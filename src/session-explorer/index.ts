#!/usr/bin/env node
// session-explorer/index.ts — CLI entry point for the session explorer.
// Two modes:
//   1. session-explorer <sessionId>  → generates a single-session HTML report
//   2. session-explorer              → launches a local session browser server

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { die, banner, bold, cyan, dim } from "../shared/ui.js";
import { findSessionFile, parseSessionDeep } from "./parser.js";
import { generateReport } from "./report.js";
import { startServer } from "./server.js";

// ─── CLI ────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Session Explorer — Deep-dive analysis of Claude Code sessions

Usage:
  session-explorer                    Launch interactive session browser
  session-explorer <sessionId>        Generate report for a specific session

Arguments:
  sessionId             Full or prefix of a Claude session ID

Options:
  --port <number>       Port for session browser (default: 3456)
  --out <path>          Custom output path for HTML report
  --json                Output raw analysis as JSON (no HTML)
  --help                Show this help message

Examples:
  session-explorer                          # Opens browser with all sessions
  session-explorer 3458a9d0                 # Report for specific session
  session-explorer --port 8080              # Browser on custom port
  session-explorer ceb20652 --out report.html
`);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  let sessionIdPrefix: string | null = null;
  let outPath: string | null = null;
  let jsonOutput = false;
  let port = 3456;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--out":
        outPath = args[++i];
        if (!outPath) {
          die("--out requires a file path", [
            "session-explorer abc123 --out ./report.html",
          ]);
        }
        break;
      case "--json":
        jsonOutput = true;
        break;
      case "--port":
        port = parseInt(args[++i], 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          die("--port requires a valid port number (1-65535)");
        }
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        if (args[i].startsWith("-")) {
          die(`Unknown option: ${args[i]}`, [
            "Run 'session-explorer --help' for usage",
          ]);
        }
        sessionIdPrefix = args[i];
    }
  }

  // ── Browser mode: no sessionId → start server ──
  if (!sessionIdPrefix) {
    banner("Session Browser", [["Mode", "Interactive browser"]]);
    startServer(port);
    return;
  }

  // ── Single session mode ──

  // Use stderr for status messages so --json output is clean on stdout
  const log = jsonOutput
    ? (...args: unknown[]) => console.error(...args)
    : (...args: unknown[]) => console.log(...args);

  // Find the session file
  let sessionInfo;
  try {
    sessionInfo = findSessionFile(sessionIdPrefix);
  } catch (err) {
    die((err as Error).message, [
      "Run with a longer prefix or full session ID",
      "Check ~/.claude/projects/ for available sessions",
    ]);
  }

  if (!jsonOutput) {
    banner("Session Analyzer", [
      ["Session", sessionInfo.sessionId],
      ["Project", sessionInfo.projectPath || "unknown"],
      ["File", sessionInfo.mainFile],
    ]);
  }

  // Parse
  log(`\n  ${dim("Parsing session...")}`);
  const analysis = parseSessionDeep(
    sessionInfo.mainFile,
    sessionInfo.sessionDir,
  );

  log(
    `  ${dim("Found")} ${bold(String(analysis.timeline.length))} ${dim("timeline events,")} ${bold(String(analysis.tasks.length))} ${dim("tasks,")} ${bold(String(analysis.subagents.length))} ${dim("subagents")}`,
  );

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(analysis, null, 2) + "\n");
    return;
  }

  // Generate report
  log(`  ${dim("Generating report...")}`);
  const html = generateReport(analysis);

  const finalPath =
    outPath ??
    path.join(os.tmpdir(), `session-${sessionInfo.sessionId.slice(0, 8)}.html`);
  fs.writeFileSync(finalPath, html);
  log(`\n  Report written to ${cyan(finalPath)}`);

  // Auto-open on macOS
  if (process.platform === "darwin") {
    try {
      execSync(`open "${finalPath}"`);
    } catch {
      /* ignore */
    }
  }
}

main();
