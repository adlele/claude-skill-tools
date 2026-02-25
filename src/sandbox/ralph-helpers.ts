// ralph-helpers.ts — Utilities for the ralph developer/reviewer iteration loop

import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

export function expandRanges(input: string): number[] {
  const nums: number[] = [];
  for (const token of input.split(/\s+/)) {
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let n = start; n <= end; n++) nums.push(n);
    } else if (/^\d+$/.test(token)) {
      nums.push(parseInt(token, 10));
    }
  }
  return nums;
}

export function parseComments(commentsFile: string): string[] {
  if (!fs.existsSync(commentsFile)) return [];
  const content = fs.readFileSync(commentsFile, "utf-8");
  const lines = content.split("\n");
  const comments: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (/^## Must Fix/.test(line) || /^## Should Fix/.test(line)) {
      inSection = true;
      continue;
    }
    if (/^## /.test(line)) {
      inSection = false;
      continue;
    }
    if (inSection && /^### /.test(line)) {
      comments.push(line);
    }
  }
  return comments;
}

export function filterIgnored(
  comments: string[],
  ignoredFile: string,
): string[] {
  if (!fs.existsSync(ignoredFile)) return comments;
  const ignored = fs.readFileSync(ignoredFile, "utf-8");
  return comments.filter(c => !ignored.includes(c));
}

function getCommitCount(worktree: string): number {
  const r = spawnSync("git", ["-C", worktree, "rev-list", "--count", "HEAD"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return parseInt(r.stdout?.trim() ?? "0", 10) || 0;
}

function getLastActivity(logFile: string, prevLines: number): string {
  try {
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.split("\n");
    // Scan new lines for tool calls in streaming-json output
    for (let i = lines.length - 1; i >= prevLines && i >= lines.length - 20; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.tool_name) {
          const target =
            event.tool_input?.file_path ??
            event.tool_input?.command?.slice(0, 40) ??
            event.tool_input?.pattern ??
            "";
          return `${event.tool_name}(${target})`;
        }
      } catch {
        // not valid JSON, try legacy plain-text pattern
        const match = line.match(/(Edit|Write|Read|Bash|Glob|Grep)\([^)]*\)/);
        if (match) return match[0];
      }
    }
  } catch {
    // file not ready yet
  }
  return "";
}

// ── Readable log generation ─────────────────────────────────

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map(l => prefix + l)
    .join("\n");
}

function formatToolInput(input: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(input)) {
    if (typeof val === "string") {
      // Truncate very long values (file content, large prompts)
      const display = val.length > 200 ? val.slice(0, 200) + "..." : val;
      lines.push(`${key}: ${display}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(val)}`);
    }
  }
  return lines.join("\n");
}

function formatContentBlock(block: Record<string, unknown>): string {
  if (block.type === "text" && typeof block.text === "string") {
    return block.text as string;
  }
  if (block.type === "tool_use") {
    const name = block.name as string;
    const input = (block.input ?? {}) as Record<string, unknown>;
    return `[TOOL_CALL] ${name}\n${indent(formatToolInput(input), "    ")}`;
  }
  if (block.type === "tool_result") {
    const content = block.content;
    if (typeof content === "string") {
      return `[TOOL_RESULT]\n${indent(content, "    ")}`;
    }
    if (Array.isArray(content)) {
      const parts = (content as Record<string, unknown>[]).map(item => {
        if (typeof item.text === "string") return item.text as string;
        if (typeof item.content === "string") return item.content as string;
        return JSON.stringify(item, null, 2);
      });
      return `[TOOL_RESULT]\n${indent(parts.join("\n"), "    ")}`;
    }
    return `[TOOL_RESULT] ${JSON.stringify(content, null, 2)}`;
  }
  return JSON.stringify(block, null, 2);
}

export function generateReadableLog(jsonLogPath: string): void {
  if (!fs.existsSync(jsonLogPath)) return;

  const readablePath = jsonLogPath.replace(/\.log$/, ".readable.log");
  const raw = fs.readFileSync(jsonLogPath, "utf-8");
  const lines = raw.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      out.push(`L${i + 1} | [PARSE_ERROR] ${line.slice(0, 100)}`);
      out.push("");
      continue;
    }

    const prefix = `L${i + 1} | `;
    const type = event.type as string;

    if (type === "system") {
      const model = (event as Record<string, unknown>).model ?? "";
      const cwd = (event as Record<string, unknown>).cwd ?? "";
      out.push(`${prefix}[SYSTEM] init model=${model} cwd=${cwd}`);
      out.push("");
      continue;
    }

    if (type === "assistant") {
      const msg = event.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? []) as Record<string, unknown>[];
      for (const block of content) {
        const formatted = formatContentBlock(block);
        out.push(`${prefix}${formatted.split("\n")[0]}`);
        const rest = formatted.split("\n").slice(1);
        if (rest.length > 0) {
          out.push(indent(rest.join("\n"), " ".repeat(prefix.length)));
        }
      }
      out.push("");
      continue;
    }

    if (type === "user") {
      const msg = event.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? []) as Record<string, unknown>[];

      // Also check for top-level tool_use_result with file info
      const toolResult = event.tool_use_result as Record<string, unknown> | undefined;

      for (const block of content) {
        const formatted = formatContentBlock(block);
        out.push(`${prefix}${formatted.split("\n")[0]}`);
        const rest = formatted.split("\n").slice(1);
        if (rest.length > 0) {
          out.push(indent(rest.join("\n"), " ".repeat(prefix.length)));
        }
      }

      // If there's a file in tool_use_result, show file path + content
      if (toolResult?.file) {
        const file = toolResult.file as Record<string, unknown>;
        const filePath = file.filePath as string;
        const fileContent = file.content as string;
        out.push(`${" ".repeat(prefix.length)}[FILE] ${filePath}`);
        if (fileContent) {
          out.push(indent(fileContent, " ".repeat(prefix.length) + "    "));
        }
      }

      out.push("");
      continue;
    }

    // Fallback for unknown event types
    out.push(`${prefix}[${type}] ${JSON.stringify(event).slice(0, 200)}`);
    out.push("");
  }

  fs.writeFileSync(readablePath, out.join("\n"), "utf-8");
}

/**
 * Run a Claude agent in the background with progress display.
 * Returns "done" if agent finished, "stopped" if user pressed 's'.
 */
export async function runAgentWithTimer(
  label: string,
  claudeArgs: string[],
  worktree: string,
  logFile: string,
): Promise<"done" | "stopped"> {
  const env = { ...process.env, SANDBOX_DIR: worktree };
  delete env.CLAUDECODE;

  const logFd = fs.openSync(logFile, "w");
  const child = spawn("claude", claudeArgs, {
    cwd: worktree,
    env,
    stdio: ["ignore", logFd, logFd],
  });

  const start = Date.now();
  const startCommits = getCommitCount(worktree);
  let prevLines = 0;
  let lastActivity = "";

  // Enable raw mode to capture keypresses without waiting for Enter
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  return new Promise(resolve => {
    let stopped = false;

    // Listen for 's' keypress
    const onData = (data: Buffer): void => {
      const key = data.toString();
      if (key === "s" || key === "S") {
        stopped = true;
        process.stdout.write(
          `\r\x1b[K  [${label}] \u26a0 Stopping agent (pid ${child.pid})...\n`,
        );
        child.kill();
      }
    };
    if (process.stdin.isTTY) {
      process.stdin.on("data", onData);
    }

    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const time = `${min}m${String(sec).padStart(2, "0")}s`;

      let curLines = 0;
      try {
        curLines = fs.readFileSync(logFile, "utf-8").split("\n").length;
      } catch {
        // not ready
      }

      if (curLines > prevLines) {
        const act = getLastActivity(logFile, prevLines);
        if (act) lastActivity = act;
      }
      prevLines = curLines;

      const newCommits = getCommitCount(worktree) - startCommits;

      let status = `  [${label}] \u23f3 ${time}`;
      if (newCommits > 0) status += ` \u2502 \ud83d\udce6 ${newCommits} commit(s)`;
      if (curLines > 0) status += ` \u2502 \ud83d\udcdd ${curLines} lines`;
      if (lastActivity) {
        const act =
          lastActivity.length > 50
            ? lastActivity.slice(0, 50) + "\u2026"
            : lastActivity;
        status += ` \u2502 ${act}`;
      }
      status += "  \x1b[2m(s=stop)\x1b[0m";

      process.stdout.write(`\r\x1b[K${status}`);
    }, 5000);

    child.on("exit", () => {
      clearInterval(timer);
      if (process.stdin.isTTY) {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }

      if (!stopped) {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const min = Math.floor(elapsed / 60);
        const sec = elapsed % 60;
        process.stdout.write(
          `\r\x1b[K  [${label}] \u23f3 ${min}m${String(sec).padStart(2, "0")}s\n`,
        );
      }

      fs.closeSync(logFd);
      resolve(stopped ? "stopped" : "done");
    });
  });
}
