// shared/ui.ts — ANSI formatting utilities shared across all CLI tools.
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

// ── Status badge ────────────────────────────────────────────

export function statusBadge(status: string): string {
  const lower = status.toLowerCase();
  switch (lower) {
    case "completed":
    case "active":
      return green(status);
    case "in_progress":
    case "running":
      return cyan(status);
    case "paused":
    case "stopped":
      return yellow(status);
    case "missing":
      return red(status);
    default:
      return status;
  }
}

// ── Boxed banner ────────────────────────────────────────────

export function banner(title: string, fields: [string, string][]): void {
  const titleLine = bold(title);
  const fieldLines = fields.map(([k, v]) => `${dim(k + ":")} ${v}`);
  const allLines = [titleLine, ...fieldLines];
  const maxLen = Math.max(...allLines.map(l => stripAnsi(l).length));
  const width = maxLen + 2;

  const boxLines = [
    "",
    cyan(`┌─${"─".repeat(width)}─┐`),
    ...allLines.map(line => {
      const pad = width - stripAnsi(line).length;
      return cyan("│ ") + line + " ".repeat(pad) + cyan(" │");
    }),
    cyan(`└─${"─".repeat(width)}─┘`),
  ];
  console.log(boxLines.join("\n"));
}

// ── Step result ─────────────────────────────────────────────

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

// ── Warnings & errors ───────────────────────────────────────

export function warn(message: string): void {
  console.log(`  ${yellow("⚠")} ${message}`);
}

export function errorBlock(
  title: string,
  details?: string,
  suggestions?: string[],
): void {
  const lines: string[] = ["", `  ${red(bold("ERROR:"))} ${title}`];
  if (details) {
    lines.push(`  ${dim(details)}`);
  }
  if (suggestions && suggestions.length > 0) {
    lines.push("", `  ${yellow("Suggestions:")}`);
    for (let i = 0; i < suggestions.length; i++) {
      lines.push(`    ${yellow(`${i + 1}.`)} ${suggestions[i]}`);
    }
  }
  lines.push("");
  console.log(lines.join("\n"));
}

export function die(message: string, suggestions?: string[]): never {
  errorBlock(message, undefined, suggestions);
  process.exit(1);
}

// ── Terminal helpers ────────────────────────────────────────

export function clearLine(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[2K");
  }
}
