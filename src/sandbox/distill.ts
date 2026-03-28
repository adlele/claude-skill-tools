// distill.ts — Generate an improved feature request from sandbox artifacts

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { getAllPromptFiles } from "../shared/paths.js";

/**
 * Extract section headings (## / ###) and top-level bullets (- ) from prompt markdown.
 * Returns lines prefixed with a `## filename` header. ## headings are promoted to ###
 * so they nest under the filename header. Returns an empty array if nothing was extracted.
 */
export function extractPromptDigest(basename: string, content: string): string[] {
  const lines = content.split("\n");
  const extracted: string[] = [`## ${basename}`];

  for (const line of lines) {
    if (/^#{2,3}\s/.test(line)) {
      extracted.push(line.startsWith("## ") ? `###${line.slice(2)}` : line);
    } else if (/^- /.test(line)) {
      extracted.push(line);
    }
  }

  // Only return if we found headings or bullets beyond the filename header
  return extracted.length > 1 ? extracted : [];
}

/**
 * Extract a compact digest from role prompt files: section headings + top-level bullets.
 * Skips files prefixed with "old_". Returns empty string if no prompts are found.
 */
export function buildRoleDigest(): string {
  let files: string[];
  try {
    files = getAllPromptFiles();
  } catch {
    return "";
  }
  if (files.length === 0) return "";

  const sections: string[] = [];

  for (const filePath of files) {
    const basename = path.basename(filePath);
    if (basename.startsWith("old_")) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const lines = extractPromptDigest(basename, content);
    if (lines.length > 0) {
      sections.push(lines.join("\n"));
    }
  }

  return sections.join("\n\n");
}

/**
 * Build the exclusion block that tells the distill model what NOT to repeat.
 * Returns empty string if no role prompts are found (graceful degradation).
 */
function buildExclusionBlock(): string {
  const digest = buildRoleDigest();
  if (!digest) return "";

  return `

IMPORTANT — The topics below are ALREADY enforced by the downstream agent system prompts (analyst, architect, developer, reviewer, tester). Do NOT include any of this generic guidance in your output. Only include decisions, constraints, and specifications SPECIFIC to this particular feature. If a guideline would apply equally to any feature in this codebase, omit it.

--- Topics already covered by role prompts (DO NOT REPEAT) ---
${digest}
--- End ---`;
}

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
- Do NOT include generic coding standards, testing conventions, naming patterns, error handling strategies, or workflow rules — these are enforced separately by the development agent prompts. Only include guidance SPECIFIC to this feature.
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

  const exclusion = buildExclusionBlock();
  const fullPrompt = `${DISTILL_PROMPT}${exclusion}

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

const IMPL_DISTILL_PROMPT = `You are a prompt engineer. You have access to:

1. feature-request.md — the original user request
2. requirements.md — clarified requirements (if available)
3. spec.md — technical specification (if available)
4. A code diff showing the actual implementation

Your task: Write the PERFECT feature request that, if given to a developer with no prior context, would lead them to produce exactly this implementation on the first try. Think of this as: "what should the user have written to get this result without iteration?"

Study the code diff to understand what was actually built. The implementation is the source of truth — the original planning documents may have been incomplete, vague, or wrong in places. Learn from the code what the real requirements and design decisions turned out to be.

The output should read as a forward-looking feature request — as if no code has been written yet. It should be detailed enough that:
- An analyst reading it would have zero clarifying questions
- An architect reading it would have zero design decisions to make
- A developer could go straight to implementation and get it right

Rules:
- Write entirely in future tense / imperative mood ("The system should...", "Add a...", "When the user...")
- NEVER reference the implementation, the code diff, or what was built — this is a feature request, not a retrospective
- NEVER use phrases like "was implemented", "diverged from spec", "was not done", "was added beyond the spec", "the code shows", etc.
- Include specific technical choices (e.g. "use spawnSync, not exec", "store state as JSON on disk")
- Include scope boundaries (what's in, what's explicitly out)
- Include non-functional requirements (performance, error handling, edge cases)
- Include integration points and constraints that a developer would need to know
- Write in the same voice/style as the original feature-request.md
- Do NOT include raw file paths or function names — describe behavior and capabilities
- Do NOT include generic coding standards, testing conventions, naming patterns, error handling strategies, or workflow rules — these are enforced separately by the development agent prompts. Only include constraints and technical choices SPECIFIC to this feature's implementation.
- Keep it as a single markdown document, ~2-4x the length of the original feature request
- Start with a # heading

Output ONLY the feature request content, no preamble.`;

/**
 * Generate a feature request that reflects the actual implementation,
 * by reading the code diff alongside the original planning artifacts.
 *
 * Shows a progress indicator while running. Press 's' to skip.
 * Returns the generated content, or null if prerequisites are missing or skipped.
 * Writes the result to {worktree}/implementation-feature-request.md on success.
 */
export async function generateImplementationFeatureRequest(
  worktree: string,
  model: string = "sonnet",
  baseBranch: string = "master",
): Promise<string | null> {
  const featureRequestPath = path.join(worktree, "feature-request.md");
  const requirementsPath = path.join(worktree, "requirements.md");
  const specPath = path.join(worktree, "spec.md");

  const featureRequest = fs.existsSync(featureRequestPath)
    ? fs.readFileSync(featureRequestPath, "utf-8")
    : "(No original feature request found)";
  const requirements = fs.existsSync(requirementsPath)
    ? fs.readFileSync(requirementsPath, "utf-8")
    : "(No requirements document found)";
  const spec = fs.existsSync(specPath)
    ? fs.readFileSync(specPath, "utf-8")
    : "(No spec document found)";

  // Get the actual code diff
  const { spawnSync } = await import("node:child_process");
  const diffResult = spawnSync(
    "git",
    ["-C", worktree, "diff", `origin/${baseBranch}...HEAD`, "--stat"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const diffStat = (diffResult.stdout ?? "").trim();

  if (!diffStat) {
    return null;
  }

  // Get the full diff, capped to avoid token explosion
  const fullDiffResult = spawnSync(
    "git",
    ["-C", worktree, "diff", `origin/${baseBranch}...HEAD`],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 },
  );
  let codeDiff = (fullDiffResult.stdout ?? "").trim();
  const MAX_DIFF_CHARS = 80_000;
  if (codeDiff.length > MAX_DIFF_CHARS) {
    codeDiff = codeDiff.slice(0, MAX_DIFF_CHARS) + "\n\n[... diff truncated ...]";
  }

  const exclusion = buildExclusionBlock();
  const fullPrompt = `${IMPL_DISTILL_PROMPT}${exclusion}

--- feature-request.md ---
${featureRequest}

--- requirements.md ---
${requirements}

--- spec.md ---
${spec}

--- Code diff (git diff origin/${baseBranch}...HEAD) ---
${codeDiff}`;

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

      const elapsed = Math.floor((Date.now() - start) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      process.stdout.write(
        `\r\x1b[K  [distill] \u2705 done in ${min}m${String(sec).padStart(2, "0")}s\n`,
      );

      if (code !== 0) {
        console.error(
          `Failed to generate implementation feature request: ${stderr.trim()}`,
        );
        resolve(null);
        return;
      }

      const content = stdout.trim();
      if (!content) {
        resolve(null);
        return;
      }

      const outputPath = path.join(worktree, "implementation-feature-request.md");
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
