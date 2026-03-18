import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as ui from "./ui.js";

export const HAS_TMUX =
  spawnSync("which", ["tmux"], { stdio: "ignore" }).status === 0;
export const IN_TMUX = !!process.env.TMUX;

export interface TmuxHandle {
  doneMarker: string;
  paneTarget: string;
}

export function runInTmux(cmd: string): TmuxHandle {
  const doneMarker = `/tmp/composer-done-${process.pid}-${Date.now()}`;
  try {
    fs.unlinkSync(doneMarker);
  } catch {
    // ignore
  }

  const escapedCmd = cmd.replace(/'/g, "'\\''");
  const result = spawnSync(
    "tmux",
    [
      "split-window",
      "-h",
      "-P",
      "-F",
      "#{pane_id}",
      `bash -c '${escapedCmd}; echo $? > ${doneMarker}'`,
    ],
    { encoding: "utf-8" },
  );
  const paneTarget = (result.stdout ?? "").trim();

  return { doneMarker, paneTarget };
}

export function cleanupPane(handle: TmuxHandle): void {
  if (handle.paneTarget) {
    spawnSync("tmux", ["kill-pane", "-t", handle.paneTarget], {
      stdio: "ignore",
    });
  }
}

/**
 * Detect ralph iteration and phase from log files in the worktree.
 * Log files (ralph-dev-N.log, ralph-rev-N.log) are created at the start of
 * each phase, so this works even before ralph-log.md has iteration entries.
 * Returns e.g. "dev 2/5" or "rev 3/5", or "" if not a ralph step.
 */
function getRalphStatus(worktree: string): string {
  try {
    // Extract max iterations from ralph-log.md header
    const logFile = path.join(worktree, "ralph-log.md");
    if (!fs.existsSync(logFile)) return "";
    const header = fs.readFileSync(logFile, "utf-8");
    const maxMatch = header.match(/Max iterations:\s*(\d+)/);
    const max = maxMatch ? maxMatch[1] : "?";

    // Find the highest-numbered dev/rev log files to determine iteration + phase
    const files = fs.readdirSync(worktree);
    let highestIter = 0;
    let latestPhase = "";
    let latestMtime = 0;

    for (const f of files) {
      const devMatch = f.match(/^ralph-dev-(\d+)\.log$/);
      const revMatch = f.match(/^ralph-rev-(\d+)\.log$/);
      const match = devMatch || revMatch;
      if (!match) continue;

      const iter = parseInt(match[1], 10);
      const mtime = fs.statSync(path.join(worktree, f)).mtimeMs;

      if (iter > highestIter || (iter === highestIter && mtime > latestMtime)) {
        highestIter = iter;
        latestPhase = devMatch ? "dev" : "rev";
        latestMtime = mtime;
      }
    }

    if (highestIter === 0) return "";
    return `${latestPhase} ${highestIter}/${max}`;
  } catch {
    return "";
  }
}

const AUTO_ADVANCE_FILE = ".ralph-auto-advance";

function isAutoAdvanceEnabled(worktree: string): boolean {
  return fs.existsSync(path.join(worktree, AUTO_ADVANCE_FILE));
}

function toggleAutoAdvance(worktree: string): boolean {
  const filePath = path.join(worktree, AUTO_ADVANCE_FILE);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return false;
  }
  fs.writeFileSync(filePath, "");
  return true;
}

export async function waitForTmuxOrSkip(handle: TmuxHandle, worktree?: string): Promise<number> {
  const keys = worktree
    ? `Press 's' to skip/kill, 'a' to toggle auto-advance, or wait for it to finish.`
    : `Press 's' here to skip/kill, or wait for it to finish.`;
  console.log(`  Step running in tmux pane '${handle.paneTarget}'.\n  ${keys}\n`);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  return new Promise<number>(resolve => {
    let settled = false;
    let tick = 0;
    const startTime = Date.now();

    const teardown = () => {
      clearInterval(check);
      ui.clearLine();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      // Clean up auto-advance file on step completion
      if (worktree) {
        try { fs.unlinkSync(path.join(worktree, AUTO_ADVANCE_FILE)); } catch {}
      }
    };

    const removeDoneMarker = () => {
      try {
        fs.unlinkSync(handle.doneMarker);
      } catch {
        // ignore
      }
    };

    const check = setInterval(() => {
      if (settled) return;

      if (fs.existsSync(handle.doneMarker)) {
        settled = true;
        const code = fs.readFileSync(handle.doneMarker, "utf-8").trim();
        removeDoneMarker();
        teardown();
        cleanupPane(handle);
        resolve(parseInt(code, 10) || 0);
        return;
      }

      // Update spinner with ralph status if available
      tick++;
      if (process.stdout.isTTY) {
        const ralph = worktree ? getRalphStatus(worktree) : "";
        const autoTag = worktree
          ? isAutoAdvanceEnabled(worktree) ? ui.green("auto") : ui.dim("manual")
          : "";
        const segments = [ui.spinnerLine(tick, startTime)];
        if (ralph) segments.push(ui.cyan(ralph));
        if (autoTag) segments.push(autoTag);
        const status = `  ${segments.join(` ${ui.dim("│")} `)}`;
        process.stdout.write(`\r\x1b[2K${status}`);
      }
    }, 500);

    const onData = (data: Buffer) => {
      if (settled) return;
      const key = data.toString().toLowerCase();
      if (key === "s") {
        settled = true;
        teardown();
        console.log("  Skipping — killing tmux pane...");
        cleanupPane(handle);
        removeDoneMarker();
        resolve(2);
      } else if (key === "a" && worktree) {
        const enabled = toggleAutoAdvance(worktree);
        const label = enabled ? ui.green("auto-advance ON") : ui.dim("auto-advance OFF");
        ui.clearLine();
        console.log(`  ${label}`);
      }
    };

    process.stdin.on("data", onData);
  });
}
