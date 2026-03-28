// size.ts — Parallel worktree size calculation with progress display

import * as fs from "node:fs";
import { spawn } from "node:child_process";
import * as ui from "../shared/ui.js";

export interface SandboxSizeResult {
  slug: string;
  branch: string;
  worktree: string;
  sizeKB: number | null; // null = missing worktree
  sizeHuman: string;     // e.g. "1.2 GB", "340 MB", "--"
}

/**
 * Format a size in kilobytes to a human-readable string.
 */
export function formatSizeKB(kb: number): string {
  if (kb >= 1_048_576) return `${(kb / 1_048_576).toFixed(1)} GB`;
  if (kb >= 1_024) return `${(kb / 1_024).toFixed(1)} MB`;
  return `${kb} KB`;
}

/**
 * Run `du -sk` on a single directory using async spawn.
 * Returns size in kilobytes, or null if the directory is missing/inaccessible.
 */
function duAsync(dirPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!fs.existsSync(dirPath)) {
      resolve(null);
      return;
    }
    const child = spawn("du", ["-sk", dirPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const match = stdout.trim().match(/^(\d+)/);
      resolve(match ? parseInt(match[1], 10) : null);
    });
  });
}

/**
 * Calculate sizes for multiple worktrees in parallel with progress feedback.
 */
export async function calculateSizes(
  entries: { slug: string; branch: string; worktree: string }[],
  showProgress = true,
): Promise<SandboxSizeResult[]> {
  const total = entries.length;
  let completed = 0;

  const updateProgress = (): void => {
    if (showProgress && process.stdout.isTTY) {
      ui.clearLine();
      process.stdout.write(
        `  ${ui.dim(`Calculating sizes... [${completed}/${total}]`)}`,
      );
    }
  };

  updateProgress();

  const promises = entries.map(async (entry) => {
    const sizeKB = await duAsync(entry.worktree);
    completed++;
    updateProgress();
    return {
      slug: entry.slug,
      branch: entry.branch,
      worktree: entry.worktree,
      sizeKB,
      sizeHuman: sizeKB != null ? formatSizeKB(sizeKB) : "--",
    };
  });

  const results = await Promise.all(promises);

  if (showProgress && process.stdout.isTTY) {
    ui.clearLine();
  }

  return results;
}
