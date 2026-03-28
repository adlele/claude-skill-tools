// retro.ts — Extract learnings from ralph review iterations

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

// ─── Comment extraction from raw .jsonl logs ────────────────────────────────

interface IterationComments {
  iteration: number;
  content: string;
}

/**
 * Extract comments.md content from a ralph-rev-N.log (raw .jsonl) file.
 * Looks for Write tool calls targeting comments.md in the assistant events.
 */
function extractCommentsFromLog(logPath: string): string | null {
  if (!fs.existsSync(logPath)) return null;

  const raw = fs.readFileSync(logPath, "utf-8");
  let lastComments: string | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type !== "assistant") continue;

    const msg = event.message as Record<string, unknown> | undefined;
    const content = (msg?.content ?? []) as Record<string, unknown>[];

    for (const block of content) {
      if (block.type !== "tool_use" || block.name !== "Write") continue;
      const input = block.input as Record<string, unknown> | undefined;
      if (!input) continue;
      const filePath = String(input.file_path ?? "");
      if (filePath.endsWith("comments.md") && input.content) {
        // Keep the last write to comments.md (reviewer may overwrite)
        lastComments = String(input.content);
      }
    }
  }

  return lastComments;
}

/**
 * Find all ralph-rev-N.log files in a worktree and extract comments.md
 * content from each iteration.
 */
export function extractAllComments(worktree: string): IterationComments[] {
  const results: IterationComments[] = [];

  for (let i = 1; i <= 100; i++) {
    const logPath = path.join(worktree, `ralph-rev-${i}.log`);
    if (!fs.existsSync(logPath)) break;

    const content = extractCommentsFromLog(logPath);
    if (content) {
      results.push({ iteration: i, content });
    }
  }

  return results;
}

// ─── Synthesis ──────────────────────────────────────────────────────────────

const RETRO_PROMPT = `You are a senior engineering coach. You've been given the review comments from multiple iterations of a code review loop, plus the ignored comments list and the summary log.

Your task: Extract **reusable learnings** that would help future AI coding sessions in this codebase. Focus on:

1. **Recurring patterns** — Mistakes or issues that appeared across multiple iterations
2. **Codebase conventions** — Style, architecture, or API patterns the reviewer enforced
3. **Common pitfalls** — Things the developer got wrong that a future developer should know upfront
4. **Quality bar** — What level of testing, error handling, or documentation the reviewer expects

Rules:
- Be specific and actionable — "Always use spawnSync for git commands" not "Be careful with processes"
- Reference the actual patterns from the comments, but generalize them into rules
- Skip one-off issues that won't recur
- Group related learnings under clear headings
- Format as a markdown document with ## headings and bullet points
- Keep it concise — aim for 10-20 bullet points total, not an essay
- Start with a # heading like "# Learnings from [context]"

Output ONLY the learnings document, no preamble.`;

/**
 * Send extracted comments to Claude for synthesis into reusable learnings.
 * Returns the synthesized content, or null if skipped/failed.
 */
export async function synthesizeLearnings(
  worktree: string,
  comments: IterationComments[],
  model: string = "sonnet",
): Promise<string | null> {
  // Build context from worktree artifacts
  const ralphLogPath = path.join(worktree, "ralph-log.md");
  const ignoredPath = path.join(worktree, "ignored-comments.txt");
  const featureRequestPath = path.join(worktree, "feature-request.md");

  const ralphLog = fs.existsSync(ralphLogPath)
    ? fs.readFileSync(ralphLogPath, "utf-8")
    : "(no ralph-log.md)";
  const ignored = fs.existsSync(ignoredPath)
    ? fs.readFileSync(ignoredPath, "utf-8")
    : "(none)";
  const featureRequest = fs.existsSync(featureRequestPath)
    ? fs.readFileSync(featureRequestPath, "utf-8").slice(0, 2000)
    : "(unknown)";

  const commentsBlock = comments
    .map(c => `--- Iteration ${c.iteration} comments.md ---\n${c.content}`)
    .join("\n\n");

  const fullPrompt = `${RETRO_PROMPT}

--- Context: feature-request.md (truncated) ---
${featureRequest}

--- Ralph loop summary (ralph-log.md) ---
${ralphLog}

--- Ignored comments ---
${ignored}

${commentsBlock}`;

  const child = spawn("claude", ["-p", "--model", model, fullPrompt], {
    cwd: worktree,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const start = Date.now();
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  return new Promise(resolve => {
    let skipped = false;

    const onData = (data: Buffer): void => {
      const key = data.toString();
      if (key === "s" || key === "S") {
        skipped = true;
        process.stdout.write(`\r\x1b[K  [retro] \u26a0 Skipping...\n`);
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
      process.stdout.write(
        `\r\x1b[K  [retro] \u23f3 ${time}  \x1b[2m(s=skip)\x1b[0m`,
      );
    }, 2000);

    child.on("exit", (code) => {
      clearInterval(timer);
      if (process.stdin.isTTY) {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }

      if (skipped) {
        resolve(null);
        return;
      }

      const elapsed = Math.floor((Date.now() - start) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      process.stdout.write(
        `\r\x1b[K  [retro] \u2705 done in ${min}m${String(sec).padStart(2, "0")}s\n`,
      );

      if (code !== 0) {
        console.error(`Failed to synthesize learnings: ${stderr.trim()}`);
        resolve(null);
        return;
      }

      const content = stdout.trim();
      if (!content) {
        resolve(null);
        return;
      }

      const outputPath = path.join(worktree, "retro-learnings.md");
      fs.writeFileSync(outputPath, content + "\n");

      resolve(content);
    });
  });
}
