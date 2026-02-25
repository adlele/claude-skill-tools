// ui.ts — ANSI formatting utilities for composer output
// Zero external deps. All color functions are no-ops when !isTTY or NO_COLOR is set.

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap =
  (code: string, reset: string) =>
  (s: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[${reset}m` : s;

export const red = wrap("31", "39");
export const green = wrap("32", "39");
export const yellow = wrap("33", "39");
export const cyan = wrap("36", "39");
export const dim = wrap("2", "22");
export const bold = wrap("1", "22");

/** Strip ANSI escape codes for accurate length calculations. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

// ── Step header ──────────────────────────────────────────────

export function stepHeader(
  current: number,
  total: number,
  label: string,
): void {
  const title = `Step ${current}/${total}: ${label}`;
  const border = "─".repeat(title.length + 2);
  console.log("");
  console.log(cyan(`┌─${border}─┐`));
  console.log(cyan(`│ `) + bold(title) + cyan(` │`));
  console.log(cyan(`└─${border}─┘`));
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

// ── Boxed banner ─────────────────────────────────────────────

export function banner(title: string, fields: [string, string][]): void {
  const titleLine = bold(title);
  const fieldLines = fields.map(([k, v]) => `${dim(k + ":")} ${v}`);
  const allLines = [titleLine, ...fieldLines];
  const maxLen = Math.max(...allLines.map(l => stripAnsi(l).length));
  const width = maxLen + 2;

  console.log("");
  console.log(cyan(`┌─${"─".repeat(width)}─┐`));
  for (const line of allLines) {
    const pad = width - stripAnsi(line).length;
    console.log(cyan("│ ") + line + " ".repeat(pad) + cyan(" │"));
  }
  console.log(cyan(`└─${"─".repeat(width)}─┘`));
}

// ── Connected pipeline ───────────────────────────────────────

export function pipeline(
  steps: { label: string }[],
  currentStep: number,
  timings: number[],
): void {
  for (let i = 0; i < steps.length; i++) {
    const isLast = i === steps.length - 1;
    let node: string;
    let label: string;
    let connector: string;

    if (i < currentStep) {
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

// ── Step result ──────────────────────────────────────────────

export function stepResult(
  ok: boolean,
  message: string,
  elapsed?: number,
): void {
  const elapsedStr =
    elapsed != null ? ` ${dim(`(${formatElapsed(elapsed)})`)}` : "";
  if (ok) {
    console.log(`  ${green("✓")} ${message}${elapsedStr}`);
  } else {
    console.log(`  ${red("✗")} ${message}${elapsedStr}`);
  }
}

export function warn(message: string): void {
  console.log(`  ${yellow("⚠")} ${message}`);
}

export function errorBlock(
  title: string,
  details?: string,
  suggestions?: string[],
): void {
  console.log("");
  console.log(`  ${red(bold("ERROR:"))} ${title}`);
  if (details) {
    console.log(`  ${dim(details)}`);
  }
  if (suggestions && suggestions.length > 0) {
    console.log("");
    console.log(`  ${yellow("Suggestions:")}`);
    for (let i = 0; i < suggestions.length; i++) {
      console.log(`    ${yellow(`${i + 1}.`)} ${suggestions[i]}`);
    }
  }
  console.log("");
}

export function statusBadge(status: string): string {
  switch (status) {
    case "completed":
      return green(status);
    case "in_progress":
      return cyan(status);
    case "paused":
      return yellow(status);
    default:
      return status;
  }
}

export function composerDie(message: string, suggestions?: string[]): never {
  errorBlock(message, undefined, suggestions);
  process.exit(1);
}

// ── Spinner ──────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerLine(tick: number, startTime: number): string {
  const frame = cyan(SPINNER_FRAMES[tick % SPINNER_FRAMES.length]);
  const elapsed = Date.now() - startTime;
  return `  ${frame} ${dim("Running...")} ${dim(formatElapsed(elapsed))}`;
}

export function clearLine(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[2K");
  }
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

// ── Relative time ───────────────────────────────────────────

export function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
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
