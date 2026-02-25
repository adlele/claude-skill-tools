#!/usr/bin/env node

// sandbox-guard.ts — PreToolUse hook that restricts file operations to the sandbox directory.
// Expects SANDBOX_DIR env var to be set to the allowed worktree path.
// Used with --dangerously-skip-permissions to limit blast radius.
//
// Reads JSON from stdin, writes JSON hook response to stdout.

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================
// CONFIG
// ============================================================

const sandboxDirRaw = process.env.SANDBOX_DIR ?? "";
if (!sandboxDirRaw) {
  // No sandbox constraint — allow everything
  process.exit(0);
}

// Resolve to absolute path
const SANDBOX_DIR = fs.realpathSync(sandboxDirRaw);

// ============================================================
// READ STDIN
// ============================================================

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk as Buffer);
}
const input = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

const toolName: string = input.tool_name ?? "";
const toolInput: Record<string, string> = input.tool_input ?? {};
const cwd: string = input.cwd ?? process.cwd();

// ============================================================
// AUDIT
// ============================================================

const auditFile = path.join(SANDBOX_DIR, "audit-raw.jsonl");
let auditDecision = "allowed";
let auditSeverity = "low";
let auditConfidence = "high";
let auditReason = "Fully validated";

function writeAudit(): void {
  const inputSummary = JSON.stringify(toolInput).slice(0, 200);
  const entry = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    tool: toolName,
    input: inputSummary,
    decision: auditDecision,
    severity: auditSeverity,
    confidence: auditConfidence,
    reason: auditReason,
  };
  try {
    fs.appendFileSync(auditFile, JSON.stringify(entry) + "\n");
  } catch {
    // ignore write errors
  }
}

function deny(reason: string): never {
  auditDecision = "flagged";
  auditSeverity = "high";
  auditConfidence = "high";
  auditReason = reason;
  writeAudit();
  const response = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(response));
  process.exit(0);
}

// ============================================================
// PATH CHECKING
// ============================================================

function resolvePath(filePath: string): string {
  if (!filePath) return "";

  // Resolve relative paths from cwd
  let resolved = filePath;
  if (!path.isAbsolute(filePath)) {
    resolved = path.join(cwd, filePath);
  }

  // Normalize (resolve .., symlinks where possible)
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // File may not exist yet — normalize without resolving symlinks
    resolved = path.resolve(resolved);
  }

  return resolved;
}

function checkPath(filePath: string): void {
  if (!filePath) return;
  const resolved = resolvePath(filePath);
  if (!resolved.startsWith(SANDBOX_DIR)) {
    deny(`Blocked: '${resolved}' is outside the sandbox directory (${SANDBOX_DIR})`);
  }
}

// ============================================================
// TOOL-SPECIFIC CHECKS
// ============================================================

switch (toolName) {
  case "Write":
  case "Edit": {
    checkPath(toolInput.file_path ?? "");
    break;
  }

  case "Bash": {
    const command = toolInput.command ?? "";

    // Block commands that explicitly reference paths outside sandbox
    if (/(?:rm|mv|cp|chmod|chown)\s/.test(command)) {
      const absolutePaths = command.match(/\/[^\s"';&|>]+/g) ?? [];
      for (const p of absolutePaths) {
        const resolved = resolvePath(p);
        // Allow system paths
        if (
          resolved.startsWith(SANDBOX_DIR) ||
          resolved.startsWith("/usr/") ||
          resolved.startsWith("/bin/") ||
          resolved.startsWith("/opt/") ||
          resolved.startsWith("/tmp/")
        ) {
          continue;
        }
        deny(`Blocked: command references '${resolved}' which is outside the sandbox directory (${SANDBOX_DIR})`);
      }
    }

    // Block cd to outside sandbox
    const cdMatch = command.match(/cd\s+(\/[^\s;&|]+)/);
    if (cdMatch) {
      const cdTarget = cdMatch[1];
      const resolved = resolvePath(cdTarget);
      if (!resolved.startsWith(SANDBOX_DIR)) {
        deny(`Blocked: 'cd ${cdTarget}' would leave the sandbox directory (${SANDBOX_DIR})`);
      }
    }

    // Classify Bash commands that were allowed but couldn't be fully validated
    if (/\b(?:curl|wget|nc|ssh|scp|rsync)\b/.test(command)) {
      auditSeverity = "high";
      auditConfidence = "low";
      auditReason = "Network operation";
    } else if (/\bgit\s+(?:push|remote|fetch|clone)\b/.test(command)) {
      auditSeverity = "high";
      auditConfidence = "low";
      auditReason = "Git remote operation";
    } else if (/(?:\$\(|\$\{|`)/.test(command)) {
      auditSeverity = "high";
      auditConfidence = "low";
      auditReason = "Variable expansion/subshell";
    } else if (command.includes("|")) {
      auditSeverity = "medium";
      auditConfidence = "low";
      auditReason = "Downstream segments unvalidated";
    } else if (command.includes("../")) {
      auditSeverity = "medium";
      auditConfidence = "low";
      auditReason = "Relative path traversal";
    }
    break;
  }
}

// Write audit entry and allow
writeAudit();
process.exit(0);
