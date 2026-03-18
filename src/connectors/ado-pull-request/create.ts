// create-pr.ts — Push branch and create an Azure DevOps PR with a summary
// built from sandbox artifacts (feature-request.md, spec.md, tasks.md,
// ralph-log.md, comments.md).
//
// Usage: create-pr.ts [options]
//   --target <branch>    Target branch (default: master)
//   --title <title>      PR title override (default: auto-generated from feature-request.md)
//   --worktree <path>    Worktree path (default: current directory)
//   --draft              Create as draft PR
//   --dry-run            Print the PR description without creating
//   --work-items <ids>   Link ADO work item IDs to the PR (comma-separated)

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { die } from "../../shared/ui.js";

// ============================================================
// ARG PARSING
// ============================================================

let target = "master";
let title = "";
let worktree = process.cwd();
let draft = false;
let dryRun = false;
let workItems = "";

const args = process.argv.slice(2);
let i = 0;
while (i < args.length) {
  switch (args[i]) {
    case "--target":
      target = args[++i] ?? "";
      i++;
      break;
    case "--title":
      title = args[++i] ?? "";
      i++;
      break;
    case "--worktree":
      worktree = args[++i] ?? "";
      i++;
      break;
    case "--draft":
      draft = true;
      i++;
      break;
    case "--dry-run":
      dryRun = true;
      i++;
      break;
    case "--work-items":
      workItems = args[++i] ?? "";
      i++;
      break;
    default:
      die(`Unknown option: ${args[i]}`);
  }
}

// Unset CLAUDECODE to avoid nested claude issues
delete process.env.CLAUDECODE;

// ============================================================
// VALIDATION
// ============================================================

if (!fs.existsSync(worktree)) die(`Cannot access worktree: ${worktree}`);

const gitCheck = spawnSync("git", ["-C", worktree, "rev-parse", "--is-inside-work-tree"], {
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (gitCheck.status !== 0) die(`Not a git repository: ${worktree}`);

const branchResult = spawnSync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], {
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
});
const branch = (branchResult.stdout ?? "").trim();
if (branch === "HEAD") die("Detached HEAD — cannot create PR");
if (branch === target) die(`Current branch is already ${target}`);

// ============================================================
// BUILD PR DESCRIPTION FROM ARTIFACTS
// ============================================================

function buildSection(file: string, heading: string, maxLines = 50): string {
  const filePath = path.join(worktree, file);
  if (!fs.existsSync(filePath)) return "";

  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  const truncated = lines.slice(0, maxLines);
  let section = `## ${heading}\n\n${truncated.join("\n")}`;

  if (lines.length > maxLines) {
    section += `\n\n_...truncated (${lines.length} lines total)_`;
  }
  return section + "\n\n";
}

let description = "";
let firstLine = "";

// Feature request / context
const featureFile = path.join(worktree, "feature-request.md");
if (fs.existsSync(featureFile)) {
  firstLine = fs.readFileSync(featureFile, "utf-8").split("\n")[0]?.replace(/^#\s*/, "") ?? "";
  description += buildSection("feature-request.md", "Feature Request", 30);
}

// Spec
description += buildSection("spec.md", "Specification", 60);

// Tasks / progress
const tasksFile = path.join(worktree, "tasks.md");
if (fs.existsSync(tasksFile)) {
  const tasksContent = fs.readFileSync(tasksFile, "utf-8");
  const taskLines = tasksContent.split("\n").filter(l => /^- \[/.test(l));
  const totalTasks = taskLines.length;
  const doneTasks = taskLines.filter(l => /^- \[x\]/.test(l)).length;

  description += `## Tasks (${doneTasks} / ${totalTasks} complete)\n\n`;
  description += taskLines.join("\n") + "\n\n";
}

// Ralph loop log
const ralphLogFile = path.join(worktree, "ralph-log.md");
if (fs.existsSync(ralphLogFile)) {
  description += "## Review Loop (Ralph)\n\n";
  description += fs.readFileSync(ralphLogFile, "utf-8") + "\n\n";
}

// Final review comments — extract summary section
const commentsFile = path.join(worktree, "comments.md");
if (fs.existsSync(commentsFile)) {
  const commentsContent = fs.readFileSync(commentsFile, "utf-8");
  const summaryLines: string[] = [];
  let inSummary = false;
  for (const line of commentsContent.split("\n")) {
    if (/^## Summary/.test(line)) {
      inSummary = true;
      continue;
    }
    if (inSummary && /^## /.test(line)) break;
    if (inSummary) summaryLines.push(line);
  }
  const summaryText = summaryLines.slice(0, 5).join("\n").trim();
  if (summaryText) {
    description += "## Last Review Summary\n\n" + summaryText + "\n\n";
  }
}

// Ignored comments
const ignoredFile = path.join(worktree, "ignored-comments.txt");
if (fs.existsSync(ignoredFile)) {
  const ignoredContent = fs.readFileSync(ignoredFile, "utf-8").trim();
  if (ignoredContent) {
    const ignoredCount = ignoredContent.split("\n").length;
    description += `## Ignored Review Comments (${ignoredCount})\n\n`;
    description += "<details>\n";
    description += "<summary>Expand to see ignored comments</summary>\n\n";
    description += ignoredContent + "\n\n";
    description += "</details>\n\n";
  }
}

// Commit log
const commitLogResult = spawnSync(
  "git",
  ["-C", worktree, "log", "--oneline", `origin/${target}..HEAD`],
  { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
);
const commitLog = (commitLogResult.stdout ?? "").trim();
if (commitLog) {
  const commitCount = commitLog.split("\n").length;
  description += `## Commits (${commitCount})\n\n`;
  description += commitLog.split("\n").slice(0, 30).join("\n") + "\n\n";
}

// Diff stats
const diffStatResult = spawnSync(
  "git",
  ["-C", worktree, "diff", "--stat", `origin/${target}..HEAD`],
  { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
);
const diffStat = (diffStatResult.stdout ?? "").trim();
if (diffStat) {
  description += "## Diff Summary\n\n```\n" + diffStat + "\n```\n\n";
}

// Auto-generate title if not provided
if (!title) {
  if (firstLine) {
    title = firstLine;
  } else {
    // Fallback: use branch name cleaned up
    title = branch
      .replace(/^sandbox\//, "")
      .replace(/-/g, " ")
      .replace(/\b(\w)/g, (_, c: string) => c.toUpperCase())
      .slice(0, 70);
  }
}

// Truncate title to 200 chars
title = title.slice(0, 200);

// Summarize description if over 4000 characters (Azure DevOps limit)
const MAX_DESC_LEN = 4000;
if (description.length > MAX_DESC_LEN) {
  console.log(`Description is ${description.length} chars (limit: ${MAX_DESC_LEN}). Summarizing...`);
  const summarizeResult = spawnSync(
    "claude",
    [
      "-p",
      "--model",
      "haiku",
      `Summarize the following PR description to under 3800 characters. Keep the markdown structure (## headings, bullet points, code blocks). Prioritize: feature request summary, key spec points, task completion status, and commit list. Drop verbose details, full file contents, and lengthy code samples. Output ONLY the summarized markdown, no preamble.\n\n${description}`,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  description = (summarizeResult.stdout ?? "").trim();
}

// ============================================================
// PREVIEW
// ============================================================

console.log("=== PR Preview ===");
console.log(`Branch: ${branch} → ${target}`);
console.log(`Title:  ${title}`);
console.log(`Description: ${description.length} chars`);
console.log("");
console.log("--- Description ---");
console.log(description);
console.log("---");
console.log("");

if (dryRun) {
  console.log("(dry run — no PR created)");
  process.exit(0);
}

// ============================================================
// PUSH & CREATE PR
// ============================================================

console.log(`Pushing ${branch} to origin...`);
const pushResult = spawnSync("git", ["-C", worktree, "push", "-u", "origin", branch], {
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (pushResult.status !== 0) {
  die(`Failed to push branch: ${(pushResult.stderr ?? "").trim()}`);
}

console.log("Creating PR...");
const azArgs = [
  "repos",
  "pr",
  "create",
  "--source-branch",
  branch,
  "--target-branch",
  target,
  "--title",
  title,
  "--description",
  description,
];

if (draft) azArgs.push("--draft");

// Link work items if provided (skip empty/placeholder values)
if (workItems && workItems !== "{ado_id}") {
  for (const wi of workItems.split(",")) {
    const trimmed = wi.trim();
    if (trimmed) {
      azArgs.push("--work-items", trimmed);
    }
  }
}

const prResult = spawnSync("az", azArgs, {
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (prResult.status !== 0) {
  die(`Failed to create PR: ${(prResult.stdout ?? "")}${(prResult.stderr ?? "")}`);
}
if (prResult.stderr?.trim()) {
  console.error(`az warnings: ${prResult.stderr.trim()}`);
}

// Extract PR details from output
let prId = "";
let prApiUrl = "";
let repoNameAdo = "";
let projectName = "";
try {
  const prOutput = JSON.parse(prResult.stdout ?? "{}");
  prId = String(prOutput.pullRequestId ?? "");
  prApiUrl = prOutput.url ?? "";
  repoNameAdo = prOutput.repository?.name ?? "";
  projectName = prOutput.repository?.project?.name ?? "";
} catch {
  // ignore parse errors
}

// Build browser URL
let prWebUrl = "";
const orgUrlMatch = prApiUrl.match(/^(https:\/\/dev\.azure\.com\/[^/]+)/);
const orgUrl = orgUrlMatch?.[1] ?? "";

if (prId && orgUrl && projectName && repoNameAdo) {
  prWebUrl = `${orgUrl}/${projectName}/_git/${repoNameAdo}/pullrequest/${prId}`;
} else if (prId) {
  const showResult = spawnSync("az", ["repos", "pr", "show", "--id", prId, "--query", "url", "-o", "tsv"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  prWebUrl = (showResult.stdout ?? "").trim();
}

console.log("");
console.log("=== PR Created ===");
console.log(`PR ID: ${prId || "unknown"}`);
if (prWebUrl) {
  console.log(`URL:   ${prWebUrl}`);
}
console.log("");

// Open in browser
if (prId) {
  console.log("Opening in browser...");
  const openResult = spawnSync("az", ["repos", "pr", "show", "--id", prId, "--open"], {
    stdio: "ignore",
  });
  if (openResult.status !== 0 && prWebUrl) {
    spawnSync("open", [prWebUrl], { stdio: "ignore" });
  }
}
