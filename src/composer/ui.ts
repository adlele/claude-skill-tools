// ui.ts — Composer-specific UI widgets + re-exports from shared UI module.

// Re-export shared primitives so existing `import * as ui from "./ui.js"` keeps working
export {
  red,
  green,
  yellow,
  cyan,
  dim,
  bold,
  stripAnsi,
  formatElapsed,
  relativeTime,
  statusBadge,
  errorBlock,
  warn,
  stepResult,
  banner,
  clearLine,
  die,
} from "../shared/ui.js";

import {
  red,
  green,
  yellow,
  cyan,
  dim,
  bold,
  stripAnsi,
  formatElapsed,
  clearLine,
} from "../shared/ui.js";

// ── Step header ──────────────────────────────────────────────

export function stepHeader(
  current: number,
  total: number,
  label: string,
): void {
  const title = `Step ${current}/${total}: ${label}`;
  const border = "─".repeat(title.length + 2);
  console.log(`\n${cyan(`┌─${border}─┐`)}\n${cyan(`│ `) + bold(title) + cyan(` │`)}\n${cyan(`└─${border}─┘`)}`);
}

// ── Progress bar ─────────────────────────────────────────────

export function progressBar(
  current: number,
  total: number,
  width = 20,
): string {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return (
    green("█".repeat(filled)) +
    dim("░".repeat(empty)) +
    dim(` ${current}/${total}`)
  );
}

// ── Compact key hints ────────────────────────────────────────

export function keyHints(): void {
  const hints = [
    `${cyan("n")}/${cyan("⏎")} run`,
    `${cyan("s")} skip`,
    `${cyan("p")} back`,
    `${cyan("q")} quit`,
    `${cyan("?")} status`,
  ];
  console.log(`  ${hints.join(dim("  │  "))}`);
}

// ── Connected pipeline ───────────────────────────────────────

export function pipeline(
  steps: { label: string }[],
  currentStep: number,
  timings: number[],
  skippedSteps?: Set<number>,
): void {
  for (let i = 0; i < steps.length; i++) {
    const isLast = i === steps.length - 1;
    let node: string;
    let label: string;
    let connector: string;

    if (skippedSteps?.has(i)) {
      node = dim("○");
      label = dim(`${steps[i].label} (skipped)`);
      connector = dim("│");
    } else if (i < currentStep) {
      node = green("●");
      const timing =
        (timings[i] ?? 0) > 0 ? dim(` (${formatElapsed(timings[i])})`) : "";
      label = `${steps[i].label}${timing}`;
      connector = green("│");
    } else if (i === currentStep) {
      node = cyan("◉");
      label = bold(steps[i].label);
      connector = dim("│");
    } else {
      node = dim("○");
      label = dim(steps[i].label);
      connector = dim("│");
    }

    console.log(`  ${node}── ${label}`);
    if (!isLast) {
      console.log(`  ${connector}`);
    }
  }
}

// ── Spinner ──────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerLine(tick: number, startTime: number): string {
  const frame = cyan(SPINNER_FRAMES[tick % SPINNER_FRAMES.length]);
  const elapsed = Date.now() - startTime;
  return `  ${frame} ${dim("Running...")} ${dim(formatElapsed(elapsed))}`;
}

// ── Countdown (auto-run with interrupt) ─────────────────────

/**
 * Show a countdown that auto-proceeds after `seconds`.
 * Returns "n" on timeout, or the key pressed ("s"/"p"/"q") on interrupt.
 * Falls back to immediate "n" if not a TTY.
 */
export function countdown(seconds: number): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve("n");

  return new Promise<string>(resolve => {
    let remaining = seconds;
    let settled = false;

    const settle = (key: string) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearLine();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      resolve(key);
    };

    const render = () => {
      if (process.stdout.isTTY) {
        const dots = cyan(".".repeat(remaining));
        process.stdout.write(
          `\r\x1b[2K  ${dim("Auto-running in")} ${bold(String(remaining))}${dots} ${dim("(s/p/q to interrupt)")}`,
        );
      }
    };

    const onData = (data: Buffer) => {
      const ch = data.toString().toLowerCase();
      if (ch === "s" || ch === "p" || ch === "q") {
        settle(ch);
      } else if (ch === "n" || ch === "\r" || ch === "\n") {
        settle("n");
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);

    render();
    const timer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        settle("n");
        console.log("");
      } else {
        render();
      }
    }, 1000);
  });
}

// ── Retry countdown ─────────────────────────────────────────

/**
 * Show a retry countdown. Returns true to retry, false if user pressed q.
 */
export function retryCountdown(seconds: number, attempt: number, maxAttempts: number): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(true);

  return new Promise<boolean>(resolve => {
    let remaining = seconds;
    let settled = false;

    const settle = (retry: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearLine();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      resolve(retry);
    };

    const render = () => {
      if (process.stdout.isTTY) {
        process.stdout.write(
          `\r\x1b[2K  ${yellow("↻")} ${dim(`Retry ${attempt}/${maxAttempts} in`)} ${bold(String(remaining))}${dim("s...")} ${dim("(q to cancel)")}`,
        );
      }
    };

    const onData = (data: Buffer) => {
      const ch = data.toString().toLowerCase();
      if (ch === "q" || ch === "\x03") {
        console.log("");
        settle(false);
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);

    render();
    const timer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        console.log("");
        settle(true);
      } else {
        render();
      }
    }, 1000);
  });
}

// ── Auto-run key hints ──────────────────────────────────────

export function keyHintsAutoRun(): void {
  const hints = [
    `${dim("auto-run")} ${cyan("⏎")}/${cyan("n")} now`,
    `${cyan("s")} skip`,
    `${cyan("p")} back`,
    `${cyan("q")} quit`,
  ];
  console.log(`  ${hints.join(dim("  │  "))}`);
}
