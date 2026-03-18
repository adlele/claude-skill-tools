// session-explorer/summary.ts — Human-readable summary generation for timeline rows.
// Pure functions, no side effects.

import * as os from "node:os";

const HOME = os.homedir();

/** Shorten absolute path by replacing $HOME with ~ */
function shortenPath(p: string | undefined): string {
  if (!p) return "unknown";
  if (HOME && p.startsWith(HOME)) return "~" + p.slice(HOME.length);
  return p;
}

/** Strip XML tags and collapse whitespace */
function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

// ─── Summary generators ─────────────────────────────────────────────────────

export function summarizeUserMessage(text: string): string {
  const cleaned = clean(text);
  if (!cleaned) return "User: (empty message)";
  return `User: ${truncate(cleaned, 150)}`;
}

export function summarizeAssistantText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Claude: (empty response)";
  return `Claude: ${truncate(cleaned, 150)}`;
}

export function summarizeToolUse(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Read":
      return `Claude read ${shortenPath(input.file_path as string)}`;

    case "Edit":
    case "MultiEdit":
      return `Claude edited ${shortenPath(input.file_path as string)}`;

    case "Write":
      return `Claude created ${shortenPath(input.file_path as string)}`;

    case "Bash": {
      const cmd = String(input.command ?? "").slice(0, 80);
      const ellipsis = String(input.command ?? "").length > 80 ? "..." : "";
      return `Claude ran \`${cmd}\`${ellipsis}`;
    }

    case "Grep":
      return `Claude searched for '${truncate(String(input.pattern ?? ""), 40)}' in ${shortenPath(input.path as string | undefined)}`;

    case "Glob":
      return `Claude searched for files matching '${truncate(String(input.pattern ?? ""), 50)}'`;

    case "Agent": {
      const agentType = input.subagent_type ?? "unknown";
      const desc = truncate(String(input.description ?? ""), 80);
      return `Claude spawned ${agentType} agent: ${desc}`;
    }

    case "ToolSearch":
      return `Claude searched for tools: ${truncate(String(input.query ?? ""), 60)}`;

    case "WebSearch":
      return `Claude searched the web for '${truncate(String(input.query ?? ""), 60)}'`;

    case "WebFetch":
      return `Claude fetched ${truncate(String(input.url ?? ""), 80)}`;

    case "NotebookEdit":
      return `Claude edited notebook ${shortenPath(input.notebook_path as string)}`;

    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return "Claude updated task list";

    case "ExitPlanMode":
      return "Claude finalized plan";

    case "EnterPlanMode":
      return "Claude entered plan mode";

    case "AskUserQuestion":
      return `Claude asked the user a question`;

    case "SendMessage":
      return `Claude sent a message`;

    default:
      return `Claude used ${toolName}`;
  }
}

export function summarizeToolResult(
  toolName: string,
  output: string,
  isError: boolean,
): string {
  if (isError) {
    const cleaned = output.replace(/\s+/g, " ").trim();
    return `Error from ${toolName}: ${truncate(cleaned, 100)}`;
  }
  const cleaned = output.replace(/\s+/g, " ").trim();
  if (!cleaned) return `Result from ${toolName}: (empty)`;
  return `Result from ${toolName}: ${truncate(cleaned, 100)}`;
}

export function summarizeThinking(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Claude reasoning: (empty)";
  return `Claude reasoning: ${truncate(cleaned, 120)}`;
}
