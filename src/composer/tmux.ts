import * as fs from "node:fs";
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

export async function waitForTmuxOrSkip(handle: TmuxHandle): Promise<number> {
  console.log(`  Step running in tmux pane '${handle.paneTarget}'.`);
  console.log("  Press 's' here to skip/kill, or wait for it to finish.");
  console.log("");

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

      // Update spinner
      tick++;
      if (process.stdout.isTTY) {
        process.stdout.write(`\r\x1b[2K${ui.spinnerLine(tick, startTime)}`);
      }
    }, 500);

    const onData = (data: Buffer) => {
      if (settled) return;
      if (data.toString().toLowerCase() === "s") {
        settled = true;
        teardown();
        console.log("  Skipping — killing tmux pane...");
        cleanupPane(handle);
        removeDoneMarker();
        resolve(2);
      }
    };

    process.stdin.on("data", onData);
  });
}
