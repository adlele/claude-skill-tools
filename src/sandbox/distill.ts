// distill.ts — Generate an improved feature request from sandbox artifacts

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

const DISTILL_PROMPT = `You are a prompt engineer. Read these three documents from a software feature development workflow:

1. feature-request.md — the original user request (may be vague)
2. requirements.md — clarified requirements produced by an analyst interviewing the user
3. spec.md — technical specification produced by an architect collaborating with the user

Your task: Write a single, self-contained feature request that incorporates ALL decisions, clarifications, and design choices from the requirements and spec. The output should be detailed enough that:
- An analyst reading it would have zero clarifying questions
- An architect reading it would have zero design decisions to make
- A developer could go straight to implementation

Rules:
- Write in the same voice/style as the original feature-request.md
- Include specific technical choices (e.g. "use React Context, not Redux")
- Include scope boundaries (what's in, what's out)
- Include non-functional requirements (performance, security, etc.)
- Do NOT include implementation details like file paths or function names
- Keep it as a single markdown document, ~2-4x the length of the original feature request
- Start with a # heading

Output ONLY the improved feature request content, no preamble.`;

/**
 * Generate an improved feature request by distilling feature-request.md,
 * requirements.md, and spec.md into a single self-contained document.
 *
 * Shows a progress indicator while running. Press 's' to skip.
 * Returns the generated content, or null if prerequisites are missing or skipped.
 * Writes the result to {worktree}/improved-feature-request.md on success.
 */
export async function generateImprovedFeatureRequest(
  worktree: string,
  model: string = "sonnet",
): Promise<string | null> {
  const featureRequestPath = path.join(worktree, "feature-request.md");
  const requirementsPath = path.join(worktree, "requirements.md");
  const specPath = path.join(worktree, "spec.md");

  // Check prerequisites
  if (!fs.existsSync(requirementsPath) || !fs.existsSync(specPath)) {
    return null;
  }

  const featureRequest = fs.existsSync(featureRequestPath)
    ? fs.readFileSync(featureRequestPath, "utf-8")
    : "(No original feature request found)";
  const requirements = fs.readFileSync(requirementsPath, "utf-8");
  const spec = fs.readFileSync(specPath, "utf-8");

  const fullPrompt = `${DISTILL_PROMPT}

--- feature-request.md ---
${featureRequest}

--- requirements.md ---
${requirements}

--- spec.md ---
${spec}`;

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

  // Enable raw mode to capture keypresses
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  return new Promise(resolve => {
    let skipped = false;

    // Listen for 's' keypress to skip
    const onData = (data: Buffer): void => {
      const key = data.toString();
      if (key === "s" || key === "S") {
        skipped = true;
        process.stdout.write(
          `\r\x1b[K  [distill] \u26a0 Skipping...\n`,
        );
        child.kill();
      }
    };
    if (process.stdin.isTTY) {
      process.stdin.on("data", onData);
    }

    // Progress indicator updated every 2 seconds
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const time = `${min}m${String(sec).padStart(2, "0")}s`;

      process.stdout.write(
        `\r\x1b[K  [distill] \u23f3 ${time}  \x1b[2m(s=skip)\x1b[0m`,
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

      // Clear the progress line
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      process.stdout.write(
        `\r\x1b[K  [distill] \u2705 done in ${min}m${String(sec).padStart(2, "0")}s\n`,
      );

      if (code !== 0) {
        console.error(
          `Failed to generate improved feature request: ${stderr.trim()}`,
        );
        resolve(null);
        return;
      }

      const content = stdout.trim();
      if (!content) {
        resolve(null);
        return;
      }

      const outputPath = path.join(worktree, "improved-feature-request.md");
      fs.writeFileSync(outputPath, content + "\n");

      resolve(content);
    });
  });
}

/**
 * Generate a changelog summarizing what changed between the original
 * feature-request.md and the improved version.
 *
 * Writes the result to {worktree}/feature-request-changes-summary.md.
 * Returns the generated content, or null on failure.
 */
export async function generateFeatureRequestChangesSummary(
  worktree: string,
  model: string = "sonnet",
): Promise<string | null> {
  const originalPath = path.join(worktree, "feature-request.md");
  const improvedPath = path.join(worktree, "improved-feature-request.md");

  if (!fs.existsSync(improvedPath)) {
    return null;
  }

  const original = fs.existsSync(originalPath)
    ? fs.readFileSync(originalPath, "utf-8")
    : "(No original feature request found)";
  const improved = fs.readFileSync(improvedPath, "utf-8");

  const prompt = `Compare the original feature request with the improved version. Produce a concise markdown changelog:
- **Added**: New requirements, constraints, or decisions not in the original
- **Clarified**: Vague items that were made specific
- **Scoped out**: Anything explicitly excluded that the original left ambiguous

Use bullet points. Be concise. No preamble.

--- Original feature-request.md ---
${original}

--- Improved feature-request.md ---
${improved}`;

  const child = spawn("claude", ["-p", "--model", model, prompt], {
    cwd: worktree,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise(resolve => {
    child.on("exit", (code) => {
      if (code !== 0) {
        console.error(
          `Failed to generate changes summary: ${stderr.trim()}`,
        );
        resolve(null);
        return;
      }

      const content = stdout.trim();
      if (!content) {
        resolve(null);
        return;
      }

      const outputPath = path.join(worktree, "feature-request-changes-summary.md");
      fs.writeFileSync(outputPath, content + "\n");
      resolve(content);
    });
  });
}

/**
 * Print a banner with the generated improved feature request and reuse instructions.
 */
export function printDistillBanner(
  content: string,
  worktree: string,
  changesSummary?: string | null,
): void {
  console.log("");
  console.log("=== Improved Feature Request Generated ===");
  console.log(
    `Saved to: ${path.join(worktree, "improved-feature-request.md")}`,
  );
  if (changesSummary) {
    console.log(
      `Changes: ${path.join(worktree, "feature-request-changes-summary.md")}`,
    );
  }
  console.log("");
  console.log("To reuse in a fresh sandbox with zero intervention:");
  console.log(
    `  sandbox start --ralph --context-file ${path.join(worktree, "improved-feature-request.md")}`,
  );
  console.log("");
  console.log("--- Content ---");
  console.log(content);
  console.log("---");
}
