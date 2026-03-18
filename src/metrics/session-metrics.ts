#!/usr/bin/env npx tsx
/**
 * Claude Code Session Metrics Analyzer
 *
 * Parses Claude Code JSONL session logs and generates per-session and per-task metrics
 * including token usage, timing, tool call breakdowns, and task classification.
 *
 * Usage: npx tsx src/metrics/session-metrics.ts [options]
 *
 * Options:
 *   --session <id>   Parse a specific session (prefix match)
 *   --full           Reparse all sessions, ignore cache
 *   --list           List sessions with basic info
 *   --branch <name>  Filter by git branch
 *   --json           Output JSON instead of pretty-print
 *   --text           Output plain text instead of HTML
 *   --html           Output HTML report (default)
 *   --out <path>     Custom output path for HTML report
 *   --help           Show usage
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { getConfigDir, migrateConfigDir } from "../shared/paths.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

// Per-model token tracking for cost calculation
export type ModelTokens = Record<string, TokenUsage>;

// Pricing per million tokens (USD)
interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "opus-4.5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "opus-4.6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "sonnet-4.5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "haiku-4.5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export function normalizeModelName(model: string): string {
  if (!model) return "unknown";
  if (model.includes("opus-4-6") || model === "opus") return "opus-4.6";
  if (
    model.includes("opus-4-5") ||
    model.includes("opus-4-1") ||
    model.includes("opus-4-")
  )
    return "opus-4.5";
  if (
    model.includes("sonnet-4-5") ||
    model.includes("sonnet-4") ||
    model === "sonnet"
  )
    return "sonnet-4.5";
  if (
    model.includes("haiku-4-5") ||
    model.includes("haiku-3-5") ||
    model === "haiku"
  )
    return "haiku-4.5";
  return "unknown";
}

export function computeCost(modelTokens: ModelTokens): number {
  let total = 0;
  for (const [model, tokens] of Object.entries(modelTokens)) {
    const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["sonnet-4.5"];
    total += (tokens.inputTokens / 1_000_000) * pricing.input;
    total += (tokens.outputTokens / 1_000_000) * pricing.output;
    total += (tokens.cacheCreationTokens / 1_000_000) * pricing.cacheWrite;
    total += (tokens.cacheReadTokens / 1_000_000) * pricing.cacheRead;
  }
  return total;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function mergeModelTokens(target: ModelTokens, source: ModelTokens): void {
  for (const [model, tokens] of Object.entries(source)) {
    if (!target[model]) {
      target[model] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
    }
    target[model].inputTokens += tokens.inputTokens;
    target[model].outputTokens += tokens.outputTokens;
    target[model].cacheCreationTokens += tokens.cacheCreationTokens;
    target[model].cacheReadTokens += tokens.cacheReadTokens;
  }
}

type TaskCategory =
  | "git-operations"
  | "testing"
  | "code-editing"
  | "planning"
  | "exploration"
  | "shell-commands"
  | "conversation"
  | "other";

export interface TaskMetrics extends TokenUsage {
  index: number;
  description: string;
  category: TaskCategory;
  wallClockMs: number;
  toolCalls: Record<string, number>;
  assistantTurns: number;
  startTime: string;
  endTime: string;
  modelTokens: ModelTokens;
  cost: number;
}

export interface SessionMetrics extends TokenUsage {
  sessionId: string;
  gitBranch: string;
  firstPrompt: string;
  summary: string;
  created: string;
  modified: string;
  wallClockMs: number;
  activeTimeMs: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: Record<string, number>;
  tasks: TaskMetrics[];
  modelTokens: ModelTokens;
  cost: number;
}

interface CachedSession {
  fileMtime: number;
  parsedAt: string;
  metrics: SessionMetrics;
}

interface ParsedState {
  version: number;
  sessions: Record<string, CachedSession>;
}

interface CliArgs {
  session: string | null;
  full: boolean;
  list: boolean;
  branch: string | null;
  json: boolean;
  text: boolean;
  out: string | null;
}

interface LogEntry {
  type: string;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  userType?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

interface ContentBlock {
  type: string;
  name?: string;
  input?: { command?: string; description?: string };
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Claude Code Session Metrics Analyzer

Usage: npx tsx src/metrics/session-metrics.ts [options]

Options:
  --session <id>   Parse a specific session by ID (prefix match supported)
  --full           Reparse all sessions, ignoring cached state
  --list           List all sessions with basic info (no metrics)
  --branch <name>  Filter sessions by git branch
  --json           Output as JSON to stdout
  --text           Output plain text to stdout
  --html           Output HTML report (default)
  --out <path>     Custom output path for HTML report
  --help           Show this help message
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    session: null,
    full: false,
    list: false,
    branch: null,
    json: false,
    text: false,
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--session":
        args.session = argv[++i];
        if (!args.session) {
          console.error("Error: --session requires a session ID argument");
          process.exit(1);
        }
        break;
      case "--full":
        args.full = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--branch":
        args.branch = argv[++i];
        if (!args.branch) {
          console.error("Error: --branch requires a branch name argument");
          process.exit(1);
        }
        break;
      case "--json":
        args.json = true;
        break;
      case "--text":
        args.text = true;
        break;
      case "--out":
        args.out = argv[++i];
        if (!args.out) {
          console.error("Error: --out requires a file path argument");
          process.exit(1);
        }
        break;
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        printUsage();
        process.exit(1);
    }
  }
  return args;
}

// ─── Project Discovery ───────────────────────────────────────────────────────

export function getProjectDir(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const encoded = dir.replace(/\//g, "-");
  const claudeDir = path.join(os.homedir(), ".claude", "projects", encoded);
  if (!fs.existsSync(claudeDir)) {
    console.error(`No Claude project found at ${claudeDir}`);
    process.exit(1);
  }
  return claudeDir;
}

// ─── Session Index ───────────────────────────────────────────────────────────

function peekSessionJsonl(filePath: string): {
  firstPrompt: string;
  gitBranch: string;
  created: string;
  messageCount: number;
} {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let firstPrompt = "";
    let gitBranch = "";
    let created = "";
    let messageCount = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!created && entry.timestamp) created = entry.timestamp;
        if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch;
        if (entry.type === "user" || entry.type === "assistant") messageCount++;
        if (!firstPrompt && entry.type === "user" && !entry.isMeta) {
          const content = entry.message?.content;
          if (
            typeof content === "string" &&
            !content.startsWith("<command-name>") &&
            !content.startsWith("<local-command") &&
            content.trim().length > 0
          ) {
            firstPrompt = content.slice(0, 200);
          }
        }
      } catch {
        /* skip */
      }
    }
    return { firstPrompt, gitBranch, created, messageCount };
  } catch {
    return { firstPrompt: "", gitBranch: "", created: "", messageCount: 0 };
  }
}

export function loadSessionIndex(projectDir: string): IndexEntry[] {
  // Load index if available
  const indexed: Map<string, IndexEntry> = new Map();
  const indexPath = path.join(projectDir, "sessions-index.json");
  if (fs.existsSync(indexPath)) {
    const data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    for (const entry of (data.entries ?? []) as IndexEntry[]) {
      indexed.set(entry.sessionId, entry);
    }
  }

  // Scan all JSONL files and merge any missing from the index
  const files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    const sessionId = path.basename(f, ".jsonl");
    if (indexed.has(sessionId)) {
      // Update mtime from disk in case index is stale
      const stat = fs.statSync(path.join(projectDir, f));
      const existing = indexed.get(sessionId)!;
      existing.fileMtime = stat.mtimeMs;
      continue;
    }
    const fullPath = path.join(projectDir, f);
    const stat = fs.statSync(fullPath);
    const peek = peekSessionJsonl(fullPath);
    indexed.set(sessionId, {
      sessionId,
      fullPath,
      fileMtime: stat.mtimeMs,
      firstPrompt: peek.firstPrompt,
      summary: "",
      messageCount: peek.messageCount,
      created: peek.created || stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      gitBranch: peek.gitBranch,
      projectPath: "",
      isSidechain: false,
    });
  }

  return Array.from(indexed.values());
}

// ─── State Management ────────────────────────────────────────────────────────

function getStateFilePath(): string {
  return path.join(getConfigDir(), "parsed-sessions.json");
}

function loadState(stateFilePath: string): ParsedState {
  if (fs.existsSync(stateFilePath)) {
    return JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));
  }
  return { version: 1, sessions: {} };
}

function saveState(stateFilePath: string, state: ParsedState): void {
  const dir = path.dirname(stateFilePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

function needsParsing(
  entry: IndexEntry,
  state: ParsedState,
  force: boolean,
): boolean {
  if (force) return true;
  const cached = state.sessions[entry.sessionId];
  if (!cached) return true;
  return entry.fileMtime > cached.fileMtime;
}

// ─── JSONL Parsing ───────────────────────────────────────────────────────────

function isHumanPrompt(entry: LogEntry): boolean {
  if (entry.type !== "user") return false;
  if (entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content !== "string") return false;
  if (content.startsWith("<command-name>")) return false;
  if (content.startsWith("<local-command")) return false;
  if (content.startsWith("<task-notification>")) return false;
  if (content.startsWith("<system-reminder>")) return false;
  if (content.trim().length === 0) return false;
  return true;
}

function isToolResult(entry: LogEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((c: ContentBlock) => c.type === "tool_result");
}

function classifyBashCommand(command: string): string {
  const trimmed = command.trim();
  if (
    /^git\s/.test(trimmed) ||
    /\|\s*git\s/.test(trimmed) ||
    /^gh\s/.test(trimmed)
  ) {
    return "Bash:git";
  }
  if (
    /\b(jest|vitest|playwright|pytest|test:unit|test:e2e|test:ci)\b/.test(
      trimmed,
    )
  ) {
    return "Bash:test";
  }
  if (
    /\b(yarn|npm|npx|pnpm)\s+(build|start|dev|staging|predev)\b/.test(trimmed)
  ) {
    return "Bash:build";
  }
  return "Bash:shell";
}

function classifyTask(toolCalls: Record<string, number>): TaskCategory {
  const has = (name: string) => (toolCalls[name] ?? 0) > 0;

  if (has("Bash:git")) return "git-operations";
  if (has("Bash:test")) return "testing";
  if (has("Edit") || has("Write") || has("MultiEdit") || has("NotebookEdit"))
    return "code-editing";
  if (
    has("ExitPlanMode") ||
    has("EnterPlanMode") ||
    has("TaskCreate") ||
    has("TaskUpdate")
  )
    return "planning";
  if (
    has("Read") ||
    has("Glob") ||
    has("Grep") ||
    has("WebSearch") ||
    has("WebFetch")
  )
    return "exploration";
  if (has("Bash:shell") || has("Bash:build")) return "shell-commands";
  if (Object.keys(toolCalls).length === 0) return "conversation";
  return "other";
}

function extractToolCalls(content: ContentBlock[]): Record<string, number> {
  const calls: Record<string, number> = {};
  for (const block of content) {
    if (block.type === "tool_use" && block.name) {
      let toolName = block.name;
      if (toolName === "Bash" && block.input?.command) {
        toolName = classifyBashCommand(block.input.command);
      }
      calls[toolName] = (calls[toolName] ?? 0) + 1;
    }
  }
  return calls;
}

function extractTokens(entry: LogEntry): TokenUsage {
  const usage = entry.message?.usage;
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
  }
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function mergeToolCalls(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [tool, count] of Object.entries(source)) {
    target[tool] = (target[tool] ?? 0) + count;
  }
}

interface TaskAccumulator {
  description: string;
  startTime: string;
  endTime: string;
  tokens: TokenUsage;
  toolCalls: Record<string, number>;
  assistantTurns: number;
  modelTokens: ModelTokens;
}

export function parseSession(filePath: string): SessionMetrics {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const entries: LogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  // Filter to relevant message types
  const messages = entries.filter(
    (e) => e.type === "user" || e.type === "assistant",
  );

  // Build tasks
  const tasks: TaskAccumulator[] = [];
  let current: TaskAccumulator | null = null;

  for (const msg of messages) {
    if (isHumanPrompt(msg)) {
      // Start a new task
      const content = msg.message?.content as string;
      current = {
        description: content.slice(0, 120),
        startTime: msg.timestamp ?? "",
        endTime: msg.timestamp ?? "",
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        toolCalls: {},
        assistantTurns: 0,
        modelTokens: {},
      };
      tasks.push(current);
    } else if (msg.type === "assistant" && current) {
      // Accumulate into current task
      const tokens = extractTokens(msg);
      current.tokens.inputTokens += tokens.inputTokens;
      current.tokens.outputTokens += tokens.outputTokens;
      current.tokens.cacheCreationTokens += tokens.cacheCreationTokens;
      current.tokens.cacheReadTokens += tokens.cacheReadTokens;
      current.assistantTurns++;
      current.endTime = msg.timestamp ?? current.endTime;

      // Track tokens per model
      const model = normalizeModelName(msg.message?.model ?? "");
      mergeModelTokens(current.modelTokens, { [model]: tokens });

      if (Array.isArray(msg.message?.content)) {
        mergeToolCalls(
          current.toolCalls,
          extractToolCalls(msg.message!.content as ContentBlock[]),
        );
      }
    } else if (isToolResult(msg) && current) {
      // Tool results continue the current task
      current.endTime = msg.timestamp ?? current.endTime;
    } else if (msg.type === "assistant" && !current) {
      // Assistant message before any user prompt (rare) — create an implicit task
      current = {
        description: "(system-initiated)",
        startTime: msg.timestamp ?? "",
        endTime: msg.timestamp ?? "",
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        toolCalls: {},
        assistantTurns: 0,
        modelTokens: {},
      };
      tasks.push(current);

      const tokens = extractTokens(msg);
      current.tokens.inputTokens += tokens.inputTokens;
      current.tokens.outputTokens += tokens.outputTokens;
      current.tokens.cacheCreationTokens += tokens.cacheCreationTokens;
      current.tokens.cacheReadTokens += tokens.cacheReadTokens;
      current.assistantTurns++;

      const model = normalizeModelName(msg.message?.model ?? "");
      mergeModelTokens(current.modelTokens, { [model]: tokens });

      if (Array.isArray(msg.message?.content)) {
        mergeToolCalls(
          current.toolCalls,
          extractToolCalls(msg.message!.content as ContentBlock[]),
        );
      }
    }
  }

  // Compute session-level aggregates
  const sessionToolCalls: Record<string, number> = {};
  const sessionModelTokens: ModelTokens = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let totalAssistantTurns = 0;
  let activeTimeMs = 0;

  const taskMetrics: TaskMetrics[] = tasks.map((t, i) => {
    const wallClockMs =
      t.startTime && t.endTime
        ? new Date(t.endTime).getTime() - new Date(t.startTime).getTime()
        : 0;
    activeTimeMs += wallClockMs;
    totalInput += t.tokens.inputTokens;
    totalOutput += t.tokens.outputTokens;
    totalCacheCreation += t.tokens.cacheCreationTokens;
    totalCacheRead += t.tokens.cacheReadTokens;
    totalAssistantTurns += t.assistantTurns;
    mergeToolCalls(sessionToolCalls, t.toolCalls);
    mergeModelTokens(sessionModelTokens, t.modelTokens);

    const taskCost = computeCost(t.modelTokens);

    return {
      index: i + 1,
      description: t.description,
      category: classifyTask(t.toolCalls),
      inputTokens: t.tokens.inputTokens,
      outputTokens: t.tokens.outputTokens,
      cacheCreationTokens: t.tokens.cacheCreationTokens,
      cacheReadTokens: t.tokens.cacheReadTokens,
      wallClockMs,
      toolCalls: t.toolCalls,
      assistantTurns: t.assistantTurns,
      startTime: t.startTime,
      endTime: t.endTime,
      modelTokens: t.modelTokens,
      cost: taskCost,
    };
  });

  // Session wall clock: first to last message timestamp
  const timestamps = messages
    .map((m) => m.timestamp)
    .filter(Boolean)
    .map((t) => new Date(t!).getTime());
  const wallClockMs =
    timestamps.length >= 2
      ? Math.max(...timestamps) - Math.min(...timestamps)
      : 0;

  const sessionCost = computeCost(sessionModelTokens);

  return {
    sessionId: "",
    gitBranch: "",
    firstPrompt: "",
    summary: "",
    created: "",
    modified: "",
    wallClockMs,
    activeTimeMs,
    userTurns: tasks.length,
    assistantTurns: totalAssistantTurns,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheCreationTokens: totalCacheCreation,
    cacheReadTokens: totalCacheRead,
    toolCalls: sessionToolCalls,
    tasks: taskMetrics,
    modelTokens: sessionModelTokens,
    cost: sessionCost,
  };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function rpad(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

// ─── Output ──────────────────────────────────────────────────────────────────

export function printSessionList(entries: IndexEntry[]): void {
  const header = `${pad("SESSION ID", 38)} ${pad("BRANCH", 20)} ${pad("CREATED", 12)} ${rpad("MSGS", 5)}  PROMPT`;
  console.log(header);
  console.log("─".repeat(header.length + 30));
  for (const e of entries) {
    const created = e.created ? e.created.slice(0, 10) : "unknown";
    const branch = truncate(e.gitBranch || "—", 20);
    const prompt = truncate(e.firstPrompt || "—", 60);
    console.log(
      `${pad(e.sessionId, 38)} ${pad(branch, 20)} ${pad(created, 12)} ${rpad(String(e.messageCount), 5)}  ${prompt}`,
    );
  }
}

export function printSessionMetrics(metrics: SessionMetrics): void {
  const sep = "═".repeat(80);
  const thinSep = "─".repeat(80);

  console.log(sep);
  console.log(`SESSION: ${metrics.sessionId}`);
  if (metrics.summary) {
    console.log(`Summary: ${metrics.summary}`);
  }
  console.log(
    `Branch:  ${metrics.gitBranch || "—"} | Created: ${(metrics.created || "—").slice(0, 16).replace("T", " ")} | Modified: ${(metrics.modified || "—").slice(0, 16).replace("T", " ")}`,
  );
  console.log(sep);

  const totalTokens =
    metrics.inputTokens +
    metrics.outputTokens +
    metrics.cacheCreationTokens +
    metrics.cacheReadTokens;
  const activePercent =
    metrics.wallClockMs > 0
      ? ((metrics.activeTimeMs / metrics.wallClockMs) * 100).toFixed(1)
      : "0";

  console.log();
  console.log("METRICS");
  console.log(`  Wall clock:      ${formatDuration(metrics.wallClockMs)}`);
  console.log(
    `  Active time:     ${formatDuration(metrics.activeTimeMs)} (${activePercent}%)`,
  );
  console.log(`  User turns:      ${metrics.userTurns}`);
  console.log(`  Assistant turns:  ${metrics.assistantTurns}`);

  console.log();
  console.log("TOKENS");
  console.log(`  Input:           ${formatTokens(metrics.inputTokens)}`);
  console.log(`  Output:          ${formatTokens(metrics.outputTokens)}`);
  console.log(
    `  Cache create:    ${formatTokens(metrics.cacheCreationTokens)}`,
  );
  console.log(`  Cache read:      ${formatTokens(metrics.cacheReadTokens)}`);
  console.log(`  Total:           ${formatTokens(totalTokens)}`);

  console.log();
  console.log("COST");
  console.log(`  Total:           ${formatCost(metrics.cost)}`);
  for (const [model, tokens] of Object.entries(metrics.modelTokens).sort(
    (a, b) => computeCost({ [b[0]]: b[1] }) - computeCost({ [a[0]]: a[1] }),
  )) {
    const modelCost = computeCost({ [model]: tokens });
    const modelTotal = totalTokensFor(tokens);
    console.log(
      `  ${pad(model, 15)} ${formatCost(modelCost)} (${formatTokens(modelTotal)} tokens)`,
    );
  }

  // Tool usage - multi-column layout
  const toolEntries = Object.entries(metrics.toolCalls).sort(
    (a, b) => b[1] - a[1],
  );
  if (toolEntries.length > 0) {
    console.log();
    console.log("TOOL USAGE");
    const cols = 3;
    for (let i = 0; i < toolEntries.length; i += cols) {
      const row = toolEntries.slice(i, i + cols);
      const formatted = row
        .map(([name, count]) => `  ${pad(name, 16)} ${rpad(String(count), 4)}`)
        .join("");
      console.log(formatted);
    }
  }

  // Tasks
  if (metrics.tasks.length > 0) {
    console.log();
    console.log(`TASKS (${metrics.tasks.length})`);
    console.log(thinSep);
    for (const task of metrics.tasks) {
      const totalTaskTokens =
        task.inputTokens +
        task.outputTokens +
        task.cacheCreationTokens +
        task.cacheReadTokens;
      const totalToolCalls = Object.values(task.toolCalls).reduce(
        (a, b) => a + b,
        0,
      );
      console.log(
        `#${task.index}  [${task.category}]  ${formatDuration(task.wallClockMs)} | ${formatTokens(totalTaskTokens)} tokens | ${totalToolCalls} tool calls | ${formatCost(task.cost)}`,
      );

      // Clean description for display (strip XML tags, collapse whitespace)
      const cleanDesc = task.description
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleanDesc) {
        console.log(`    "${truncate(cleanDesc, 90)}"`);
      }

      // Tool breakdown
      const taskToolEntries = Object.entries(task.toolCalls).sort(
        (a, b) => b[1] - a[1],
      );
      if (taskToolEntries.length > 0) {
        const toolStr = taskToolEntries
          .map(([name, count]) => `${name}(${count})`)
          .join(", ");
        console.log(`    Tools: ${toolStr}`);
      }
      console.log();
    }
  }

  console.log(sep);
}

// ─── HTML Report ─────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  "code-editing": "#58a6ff",
  exploration: "#3fb950",
  "git-operations": "#f97583",
  testing: "#d2a8ff",
  planning: "#f0883e",
  "shell-commands": "#79c0ff",
  conversation: "#8b949e",
  other: "#6e7681",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanDescription(desc: string): string {
  return desc
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function totalTokensFor(m: TokenUsage): number {
  return (
    m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens
  );
}

export function generateHtmlReport(sessions: SessionMetrics[]): string {
  // Aggregate stats
  const totalSessions = sessions.length;
  const totalTasks = sessions.reduce((s, m) => s + m.tasks.length, 0);
  const aggTokens = sessions.reduce((s, m) => s + totalTokensFor(m), 0);
  const aggActiveMs = sessions.reduce((s, m) => s + m.activeTimeMs, 0);
  const aggWallMs = sessions.reduce((s, m) => s + m.wallClockMs, 0);
  const aggCost = sessions.reduce((s, m) => s + m.cost, 0);
  const aggInput = sessions.reduce((s, m) => s + m.inputTokens, 0);
  const aggOutput = sessions.reduce((s, m) => s + m.outputTokens, 0);
  const aggCacheCreate = sessions.reduce(
    (s, m) => s + m.cacheCreationTokens,
    0,
  );
  const aggCacheRead = sessions.reduce((s, m) => s + m.cacheReadTokens, 0);
  const aggToolCalls: Record<string, number> = {};
  const categoryCounts: Record<string, number> = {};
  const aggModelTokens: ModelTokens = {};
  const costByCategory: Record<string, number> = {};
  const costByDate: Record<string, number> = {};
  for (const m of sessions) {
    mergeToolCalls(aggToolCalls, m.toolCalls);
    mergeModelTokens(aggModelTokens, m.modelTokens);
    const dateKey = m.created ? m.created.slice(0, 10) : "unknown";
    costByDate[dateKey] = (costByDate[dateKey] ?? 0) + m.cost;
    for (const t of m.tasks) {
      categoryCounts[t.category] = (categoryCounts[t.category] ?? 0) + 1;
      costByCategory[t.category] = (costByCategory[t.category] ?? 0) + t.cost;
    }
  }

  const sortedTools = Object.entries(aggToolCalls).sort((a, b) => b[1] - a[1]);
  const maxToolCount = sortedTools.length > 0 ? sortedTools[0][1] : 1;

  const sortedCategories = Object.entries(categoryCounts).sort(
    (a, b) => b[1] - a[1],
  );
  const maxCatCount = sortedCategories.length > 0 ? sortedCategories[0][1] : 1;

  const sortedCostByCat = Object.entries(costByCategory).sort(
    (a, b) => b[1] - a[1],
  );
  const maxCostByCat = sortedCostByCat.length > 0 ? sortedCostByCat[0][1] : 1;

  const sortedCostByDate = Object.entries(costByDate).sort((a, b) =>
    b[0].localeCompare(a[0]),
  );
  const maxCostByDate =
    sortedCostByDate.length > 0
      ? Math.max(...sortedCostByDate.map(([, v]) => v))
      : 1;

  // Cost by model for dashboard
  const modelCosts = Object.entries(aggModelTokens)
    .map(([model, tokens]) => ({
      model,
      cost: computeCost({ [model]: tokens }),
      tokens: totalTokensFor(tokens),
    }))
    .sort((a, b) => b.cost - a.cost);
  const maxModelCost = modelCosts.length > 0 ? modelCosts[0].cost : 1;

  const tokenParts = [
    { label: "Input", value: aggInput, color: "#58a6ff" },
    { label: "Output", value: aggOutput, color: "#3fb950" },
    { label: "Cache Create", value: aggCacheCreate, color: "#f0883e" },
    { label: "Cache Read", value: aggCacheRead, color: "#d2a8ff" },
  ];

  // Sessions table rows
  const sessionRows = sessions
    .map((m) => {
      const tokens = totalTokensFor(m);
      const topCategory =
        m.tasks.length > 0
          ? Object.entries(
              m.tasks.reduce(
                (acc, t) => {
                  acc[t.category] = (acc[t.category] ?? 0) + 1;
                  return acc;
                },
                {} as Record<string, number>,
              ),
            ).sort((a, b) => b[1] - a[1])[0][0]
          : "—";
      return `<tr class="session-row" data-session="${esc(m.sessionId)}">
        <td title="${esc(m.summary || cleanDescription(m.firstPrompt) || "")}" data-click="session" data-id="${esc(m.sessionId)}">${esc(m.summary || cleanDescription(m.firstPrompt) || "—")}</td>
        <td title="${esc(m.gitBranch || "")}" data-click="branch" data-value="${esc(m.gitBranch || "")}">${esc(m.gitBranch || "—")}</td>
        <td data-sort="${m.created ? new Date(m.created).getTime() : 0}" data-click="date" data-value="${m.created ? m.created.slice(0, 10) : ""}">${m.created ? m.created.slice(0, 10) : "—"}</td>
        <td data-sort="${m.activeTimeMs}" data-click="session" data-id="${esc(m.sessionId)}">${formatDuration(m.activeTimeMs)}</td>
        <td data-sort="${tokens}" data-click="session" data-id="${esc(m.sessionId)}">${formatTokens(tokens)}</td>
        <td data-sort="${m.cost}" data-click="session" data-id="${esc(m.sessionId)}">${formatCost(m.cost)}</td>
        <td data-sort="${m.tasks.length}" data-click="session" data-id="${esc(m.sessionId)}">${m.tasks.length}</td>
        <td data-click="category" data-value="${esc(topCategory)}"><span class="badge" style="background:${CATEGORY_COLORS[topCategory] ?? "#6e7681"}">${esc(topCategory)}</span></td>
      </tr>`;
    })
    .join("\n");

  // Per-session detail panels (hidden by default, shown on click)
  const sessionPanels = sessions
    .map((m) => {
      const tokens = totalTokensFor(m);
      const activePercent =
        m.wallClockMs > 0
          ? ((m.activeTimeMs / m.wallClockMs) * 100).toFixed(1)
          : "0";

      const sTools = Object.entries(m.toolCalls).sort((a, b) => b[1] - a[1]);
      const sMaxTool = sTools.length > 0 ? sTools[0][1] : 1;
      const toolBars = sTools
        .map(
          ([name, count]) =>
            `<div class="bar-row"><span class="bar-label">${esc(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${(count / sMaxTool) * 100}%;background:#58a6ff"></div></div><span class="bar-value">${count}</span></div>`,
        )
        .join("");

      const sParts = [
        { label: "Input", value: m.inputTokens, color: "#58a6ff" },
        { label: "Output", value: m.outputTokens, color: "#3fb950" },
        {
          label: "Cache Create",
          value: m.cacheCreationTokens,
          color: "#f0883e",
        },
        { label: "Cache Read", value: m.cacheReadTokens, color: "#d2a8ff" },
      ];
      const sTokenTotal = tokens || 1;

      // Cost by model for this session
      const sModelCosts = Object.entries(m.modelTokens)
        .map(([model, tok]) => ({
          model,
          cost: computeCost({ [model]: tok }),
          tokens: totalTokensFor(tok),
        }))
        .sort((a, b) => b.cost - a.cost);
      const sMaxModelCost = sModelCosts.length > 0 ? sModelCosts[0].cost : 1;

      const taskRows = m.tasks
        .map((t) => {
          const tTokens = totalTokensFor(t);
          const tToolCount = Object.values(t.toolCalls).reduce(
            (a, b) => a + b,
            0,
          );
          const toolStr = Object.entries(t.toolCalls)
            .sort((a, b) => b[1] - a[1])
            .map(([n, c]) => `${esc(n)}(${c})`)
            .join(", ");
          const desc = cleanDescription(t.description);
          return `<tr>
            <td>${t.index}</td>
            <td><span class="badge" style="background:${CATEGORY_COLORS[t.category] ?? "#6e7681"}">${esc(t.category)}</span></td>
            <td>${formatDuration(t.wallClockMs)}</td>
            <td>${formatTokens(tTokens)}</td>
            <td>${formatCost(t.cost)}</td>
            <td>${tToolCount}</td>
            <td class="desc-cell" title="${esc(desc)}">${esc(truncate(desc, 80))}</td>
            <td class="tools-cell">${toolStr}</td>
          </tr>`;
        })
        .join("");

      return `
      <div id="session-${esc(m.sessionId)}" class="session-detail" style="display:none">
        <div class="session-header">
          <h2>${esc(m.summary || cleanDescription(m.firstPrompt).slice(0, 80) || m.sessionId)}</h2>
          <div class="session-meta">
            <span>Branch: <strong>${esc(m.gitBranch || "—")}</strong></span>
            <span>Created: <strong>${m.created ? m.created.slice(0, 10) : "—"}</strong></span>
            <span>ID: <code>${esc(m.sessionId.slice(0, 8))}</code></span>
          </div>
        </div>

        <div class="metrics-cards">
          <div class="card"><div class="card-value">${formatDuration(m.wallClockMs)}</div><div class="card-label">Wall Clock</div></div>
          <div class="card"><div class="card-value">${formatDuration(m.activeTimeMs)}</div><div class="card-label">Active (${activePercent}%)</div></div>
          <div class="card"><div class="card-value">${formatTokens(tokens)}</div><div class="card-label">Tokens</div></div>
          <div class="card"><div class="card-value cost-value">${formatCost(m.cost)}</div><div class="card-label">Est. Cost</div></div>
          <div class="card"><div class="card-value">${m.userTurns}</div><div class="card-label">User Turns</div></div>
          <div class="card"><div class="card-value">${m.assistantTurns}</div><div class="card-label">Assistant Turns</div></div>
        </div>

        <div class="charts-row">
          <div class="chart-box">
            <h3>Token Breakdown</h3>
            <div class="stacked-bar">
              ${sParts.map((p) => `<div class="stacked-seg" style="width:${(p.value / sTokenTotal) * 100}%;background:${p.color}" title="${p.label}: ${formatTokens(p.value)}"></div>`).join("")}
            </div>
            <div class="legend">${sParts.map((p) => `<span class="legend-item"><span class="legend-dot" style="background:${p.color}"></span>${p.label}: ${formatTokens(p.value)}</span>`).join("")}</div>
          </div>
          <div class="chart-box">
            <h3>Cost by Model</h3>
            <div class="chart-scroll">${sModelCosts
              .map(
                ({ model, cost, tokens: tok }) =>
                  `<div class="bar-row"><span class="bar-label">${esc(model)}</span><div class="bar-track"><div class="bar-fill" style="width:${(cost / sMaxModelCost) * 100}%;background:#f97583"></div></div><span class="bar-value">${formatCost(cost)}</span></div>`,
              )
              .join("")}</div>
          </div>
        </div>

        <div class="charts-row">
          <div class="chart-box">
            <h3>Tool Usage</h3>
            <div class="chart-scroll">${toolBars || "<p class='muted'>No tool calls</p>"}</div>
          </div>
          <div class="chart-box"></div>
        </div>

        ${
          m.tasks.length > 0
            ? `<h3>Tasks (${m.tasks.length})</h3>
        <table class="tasks-table">
          <thead><tr><th>#</th><th>Category</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Tools</th><th>Description</th><th>Tool Breakdown</th></tr></thead>
          <tbody>${taskRows}</tbody>
        </table>`
            : ""
        }
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session Metrics</title>
<link rel="icon" href="https://cdn-icons-png.flaticon.com/512/3840/3840696.png" type="image/png">
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d;
    --text: #e6edf3; --text2: #8b949e; --accent: #58a6ff; --cost: #f97583;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: var(--bg3); padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }

  .top-nav { position: sticky; top: 0; z-index: 100; background: var(--bg2); border-bottom: 1px solid var(--border); padding: 10px 24px; display: flex; justify-content: space-between; align-items: center; }
  .top-nav h1 { font-size: 1.1rem; font-weight: 600; }
  .top-nav .nav-info { color: var(--text2); font-size: 0.85rem; }

  .container { max-width: 1400px; margin: 0 auto; padding: 24px; }

  .dashboard { margin-bottom: 40px; }
  .dashboard h2 { font-size: 1.3rem; margin-bottom: 16px; }
  .metrics-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px; text-align: center; }
  .card-value { font-size: 1.6rem; font-weight: 700; color: var(--accent); }
  .card-label { font-size: 0.8rem; color: var(--text2); margin-top: 4px; }
  .cost-value { color: var(--cost) !important; }

  .charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  @media (max-width: 800px) { .charts-row { grid-template-columns: 1fr; } }
  .chart-box { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px; overflow: hidden; min-width: 0; }
  .chart-box h3 { font-size: 0.95rem; margin-bottom: 12px; color: var(--text2); }
  .chart-scroll { max-height: 110px; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; -ms-overflow-style: none; min-width: 0; }
  .chart-scroll::-webkit-scrollbar { display: none; }

  .stacked-bar { display: flex; height: 24px; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
  .stacked-seg { min-width: 2px; transition: width 0.3s; }
  .stacked-seg:hover { opacity: 0.8; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.8rem; color: var(--text2); }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

  .bar-row { display: flex; align-items: center; margin-bottom: 6px; min-width: 0; }
  .bar-label { width: 120px; min-width: 120px; font-size: 0.8rem; color: var(--text2); text-align: right; padding-right: 10px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; min-width: 0; background: var(--bg3); border-radius: 3px; height: 16px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .bar-value { min-width: 60px; width: 60px; font-size: 0.8rem; color: var(--text2); text-align: right; padding-left: 8px; flex-shrink: 0; white-space: nowrap; }

  .sessions-table { width: 100%; border-collapse: collapse; margin-bottom: 40px; font-size: 0.85rem; }
  .sessions-table { table-layout: fixed; }
  .sessions-table th { text-align: left; padding: 10px 12px; border-bottom: 2px solid var(--border); color: var(--text2); font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; position: relative; overflow: hidden; text-overflow: ellipsis; }
  .sessions-table th:hover { color: var(--accent); }
  .sessions-table th.sorted-asc::after { content: ' \\25B2'; font-size: 0.7em; }
  .sessions-table th.sorted-desc::after { content: ' \\25BC'; font-size: 0.7em; }
  .sessions-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .col-resize-handle { position: absolute; right: 0; top: 0; bottom: 0; width: 5px; cursor: col-resize; z-index: 1; }
  .col-resize-handle:hover, .col-resize-handle.active { background: var(--accent); opacity: 0.5; }
  body.col-resizing { cursor: col-resize !important; user-select: none; }
  body.col-resizing * { cursor: col-resize !important; }
  .session-row { transition: background 0.15s; }
  .session-row:hover { background: var(--bg3); }
  .session-row td { cursor: pointer; }
  .session-row td[data-click="branch"],
  .session-row td[data-click="date"],
  .session-row td[data-click="category"] { color: var(--accent); }
  .session-row td[data-click="branch"]:hover,
  .session-row td[data-click="date"]:hover,
  .session-row td[data-click="category"]:hover { text-decoration: underline; }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; color: #fff; white-space: nowrap; }

  .session-detail { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .session-header { margin-bottom: 16px; }
  .session-header h2 { font-size: 1.15rem; margin-bottom: 6px; }
  .session-meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 0.8rem; color: var(--text2); align-items: center; }
  .back-link { margin-left: auto; }

  .tasks-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 12px; }
  .tasks-table th { text-align: left; padding: 8px; border-bottom: 2px solid var(--border); color: var(--text2); font-weight: 600; }
  .tasks-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .desc-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tools-cell { font-size: 0.75rem; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .muted { color: var(--text2); font-size: 0.85rem; }
  .generated { text-align: center; color: var(--text2); font-size: 0.8rem; padding: 24px; }

  /* View transitions */
  #dashboard-view, #session-viewer { transition: opacity 0.15s; }
  #session-viewer { display: none; }

  /* Breadcrumb nav bar */
  .breadcrumb-bar { position: sticky; top: 41px; z-index: 99; background: var(--bg); border-bottom: 1px solid var(--border); padding: 8px 24px; display: flex; align-items: center; gap: 8px; font-size: 0.85rem; }
  .breadcrumb-bar .nav-btn { background: var(--bg3); border: 1px solid var(--border); color: var(--text2); border-radius: 6px; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 1rem; transition: background 0.15s, color 0.15s; flex-shrink: 0; }
  .breadcrumb-bar .nav-btn:hover:not(:disabled) { background: var(--accent); color: #fff; border-color: var(--accent); }
  .breadcrumb-bar .nav-btn:disabled { opacity: 0.3; cursor: default; }
  .breadcrumb-bar .sep { color: var(--text2); margin: 0 2px; }
  .breadcrumb-bar .crumb { color: var(--text2); }
  .breadcrumb-bar .crumb-link { color: var(--accent); cursor: pointer; }
  .breadcrumb-bar .crumb-link:hover { text-decoration: underline; }
  .breadcrumb-bar .crumb-current { color: var(--text); font-weight: 600; max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>

<nav class="top-nav" id="top">
  <h1>Claude Session Metrics</h1>
  <div class="nav-info">${totalSessions} sessions | ${totalTasks} tasks | ${formatCost(aggCost)} est. cost | Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}</div>
</nav>

<div class="breadcrumb-bar" id="breadcrumb-bar">
  <button class="nav-btn" id="nav-back" title="Go back" disabled onclick="navBack()">&#8592;</button>
  <button class="nav-btn" id="nav-forward" title="Go forward" disabled onclick="navForward()">&#8594;</button>
  <span id="crumb-dashboard" class="crumb-current">Dashboard</span>
  <span class="sep" id="crumb-sep" style="display:none">/</span>
  <span class="crumb-current" id="breadcrumb-title" style="display:none"></span>
</div>

<div class="container">

  <!-- Dashboard View -->
  <div id="dashboard-view">
    <div class="dashboard">
      <h2>Overview</h2>
      <div class="metrics-cards">
        <div class="card"><div class="card-value">${totalSessions}</div><div class="card-label">Sessions</div></div>
        <div class="card"><div class="card-value">${totalTasks}</div><div class="card-label">Tasks</div></div>
        <div class="card"><div class="card-value">${formatTokens(aggTokens)}</div><div class="card-label">Total Tokens</div></div>
        <div class="card"><div class="card-value cost-value">${formatCost(aggCost)}</div><div class="card-label">Est. Cost</div></div>
        <div class="card"><div class="card-value">${formatDuration(aggActiveMs)}</div><div class="card-label">Active Time</div></div>
        <div class="card"><div class="card-value">${formatDuration(aggWallMs)}</div><div class="card-label">Wall Clock</div></div>
      </div>

      <div class="charts-row">
        <div class="chart-box">
          <h3>Token Distribution</h3>
          <div class="stacked-bar">
            ${tokenParts.map((p) => `<div class="stacked-seg" style="width:${(p.value / (aggTokens || 1)) * 100}%;background:${p.color}" title="${p.label}: ${formatTokens(p.value)}"></div>`).join("")}
          </div>
          <div class="legend">${tokenParts.map((p) => `<span class="legend-item"><span class="legend-dot" style="background:${p.color}"></span>${p.label}: ${formatTokens(p.value)}</span>`).join("")}</div>
        </div>
        <div class="chart-box">
          <h3>Cost by Model</h3>
          <div class="chart-scroll">${modelCosts
            .map(
              ({ model, cost }) =>
                `<div class="bar-row"><span class="bar-label">${esc(model)}</span><div class="bar-track"><div class="bar-fill" style="width:${(cost / maxModelCost) * 100}%;background:#f97583"></div></div><span class="bar-value">${formatCost(cost)}</span></div>`,
            )
            .join("")}</div>
        </div>
      </div>

      <div class="charts-row">
        <div class="chart-box">
          <h3>Task Categories</h3>
          <div class="chart-scroll">${sortedCategories.map(([cat, count]) => `<div class="bar-row"><span class="bar-label">${esc(cat)}</span><div class="bar-track"><div class="bar-fill" style="width:${(count / maxCatCount) * 100}%;background:${CATEGORY_COLORS[cat] ?? "#6e7681"}"></div></div><span class="bar-value">${count}</span></div>`).join("")}</div>
        </div>
        <div class="chart-box">
          <h3>Top Tools (All Sessions)</h3>
          <div class="chart-scroll">${sortedTools
            .slice(0, 12)
            .map(
              ([name, count]) =>
                `<div class="bar-row"><span class="bar-label">${esc(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${(count / maxToolCount) * 100}%;background:#58a6ff"></div></div><span class="bar-value">${count}</span></div>`,
            )
            .join("")}</div>
        </div>
      </div>

      <div class="charts-row">
        <div class="chart-box">
          <h3>Cost by Category</h3>
          <div class="chart-scroll">${sortedCostByCat.map(([cat, cost]) => `<div class="bar-row"><span class="bar-label">${esc(cat)}</span><div class="bar-track"><div class="bar-fill" style="width:${(cost / maxCostByCat) * 100}%;background:${CATEGORY_COLORS[cat] ?? "#6e7681"}"></div></div><span class="bar-value">${formatCost(cost)}</span></div>`).join("")}</div>
        </div>
        <div class="chart-box">
          <h3>Cost by Date</h3>
          <div class="chart-scroll">${sortedCostByDate.map(([date, cost]) => `<div class="bar-row"><span class="bar-label">${esc(date)}</span><div class="bar-track"><div class="bar-fill" style="width:${(cost / maxCostByDate) * 100}%;background:#f97583"></div></div><span class="bar-value">${formatCost(cost)}</span></div>`).join("")}</div>
        </div>
      </div>
    </div>

    <h2 style="margin-bottom:12px">Sessions</h2>
    <table class="sessions-table" id="sessions-table">
      <thead>
        <tr>
          <th data-col="0">Summary</th>
          <th data-col="1">Branch</th>
          <th data-col="2">Created</th>
          <th data-col="3">Active Time</th>
          <th data-col="4">Tokens</th>
          <th data-col="5">Cost</th>
          <th data-col="6">Tasks</th>
          <th data-col="7">Top Category</th>
        </tr>
      </thead>
      <tbody>
        ${sessionRows}
      </tbody>
    </table>
  </div>

  <!-- Session Viewer (shown when a session is clicked) -->
  <div id="session-viewer">
    ${sessionPanels}
  </div>

  <!-- Aggregate Viewer (shown when branch/date/category is clicked) -->
  <div id="aggregate-viewer" style="display:none">
    <div id="aggregate-content"></div>
  </div>

  <div class="generated">Generated by session-metrics</div>
</div>

<script>
// Embedded session data for client-side aggregation
const ALL_SESSIONS = ${JSON.stringify(
    sessions.map((m) => ({
      sessionId: m.sessionId,
      summary:
        m.summary ||
        cleanDescription(m.firstPrompt).slice(0, 80) ||
        m.sessionId.slice(0, 8),
      gitBranch: m.gitBranch,
      created: m.created,
      modified: m.modified,
      wallClockMs: m.wallClockMs,
      activeTimeMs: m.activeTimeMs,
      userTurns: m.userTurns,
      assistantTurns: m.assistantTurns,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheCreationTokens: m.cacheCreationTokens,
      cacheReadTokens: m.cacheReadTokens,
      cost: m.cost,
      toolCalls: m.toolCalls,
      modelTokens: m.modelTokens,
      tasks: m.tasks.map((t) => ({
        category: t.category,
        cost: t.cost,
        wallClockMs: t.wallClockMs,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheCreationTokens: t.cacheCreationTokens,
        cacheReadTokens: t.cacheReadTokens,
        toolCalls: t.toolCalls,
      })),
    })),
  )};

const CATEGORY_COLORS = ${JSON.stringify(CATEGORY_COLORS)};
const MODEL_PRICING = ${JSON.stringify(MODEL_PRICING)};

// Session title lookup
const SESSION_TITLES = {};
ALL_SESSIONS.forEach(m => { SESSION_TITLES[m.sessionId] = m.summary; });

// Utility functions (client-side mirrors of server-side)
function fmtDur(ms) {
  if (ms < 0) return '0s';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins < 60) return mins + 'm ' + secs + 's';
  return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}

function fmtTok(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1000000).toFixed(2) + 'M';
}

function fmtCost(usd) {
  if (usd < 0.01) return '$' + (usd * 100).toFixed(2) + 'c';
  if (usd < 1) return '$' + usd.toFixed(3);
  return '$' + usd.toFixed(2);
}

function totalTok(m) { return m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens; }
function escH(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function computeModelCost(modelTokens) {
  let total = 0;
  for (const [model, tokens] of Object.entries(modelTokens)) {
    const p = MODEL_PRICING[model] || MODEL_PRICING['sonnet-4.5'];
    total += (tokens.inputTokens / 1e6) * p.input + (tokens.outputTokens / 1e6) * p.output +
             (tokens.cacheCreationTokens / 1e6) * p.cacheWrite + (tokens.cacheReadTokens / 1e6) * p.cacheRead;
  }
  return total;
}

function mergeObj(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      if (!target[k]) target[k] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      target[k].inputTokens += v.inputTokens || 0;
      target[k].outputTokens += v.outputTokens || 0;
      target[k].cacheCreationTokens += v.cacheCreationTokens || 0;
      target[k].cacheReadTokens += v.cacheReadTokens || 0;
    } else {
      target[k] = (target[k] || 0) + v;
    }
  }
}

function renderAggregateView(filterType, filterValue, filtered) {
  const n = filtered.length;
  const totalTasks = filtered.reduce((s, m) => s + m.tasks.length, 0);
  const aggTok = filtered.reduce((s, m) => s + totalTok(m), 0);
  const aggActive = filtered.reduce((s, m) => s + m.activeTimeMs, 0);
  const aggWall = filtered.reduce((s, m) => s + m.wallClockMs, 0);
  const aggCost = filtered.reduce((s, m) => s + m.cost, 0);
  const aggInput = filtered.reduce((s, m) => s + m.inputTokens, 0);
  const aggOutput = filtered.reduce((s, m) => s + m.outputTokens, 0);
  const aggCC = filtered.reduce((s, m) => s + m.cacheCreationTokens, 0);
  const aggCR = filtered.reduce((s, m) => s + m.cacheReadTokens, 0);

  const aggTools = {};
  const catCounts = {};
  const aggModelTok = {};
  filtered.forEach(m => {
    mergeObj(aggTools, m.toolCalls);
    mergeObj(aggModelTok, m.modelTokens);
    m.tasks.forEach(t => { catCounts[t.category] = (catCounts[t.category] || 0) + 1; });
  });

  const sortedTools = Object.entries(aggTools).sort((a, b) => b[1] - a[1]);
  const maxTool = sortedTools.length > 0 ? sortedTools[0][1] : 1;
  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
  const maxCat = sortedCats.length > 0 ? sortedCats[0][1] : 1;

  const modelCosts = Object.entries(aggModelTok)
    .map(([model, tok]) => ({ model, cost: computeModelCost({ [model]: tok }) }))
    .sort((a, b) => b.cost - a.cost);
  const maxMC = modelCosts.length > 0 ? modelCosts[0].cost : 1;

  const tokParts = [
    { label: 'Input', value: aggInput, color: '#58a6ff' },
    { label: 'Output', value: aggOutput, color: '#3fb950' },
    { label: 'Cache Create', value: aggCC, color: '#f0883e' },
    { label: 'Cache Read', value: aggCR, color: '#d2a8ff' },
  ];

  const label = filterType === 'branch' ? 'Branch' : filterType === 'date' ? 'Date' : 'Category';

  let html = '<div class="dashboard">';
  html += '<h2>' + escH(label) + ': ' + escH(filterValue) + '</h2>';

  // Cards
  html += '<div class="metrics-cards">';
  html += '<div class="card"><div class="card-value">' + n + '</div><div class="card-label">Sessions</div></div>';
  html += '<div class="card"><div class="card-value">' + totalTasks + '</div><div class="card-label">Tasks</div></div>';
  html += '<div class="card"><div class="card-value">' + fmtTok(aggTok) + '</div><div class="card-label">Total Tokens</div></div>';
  html += '<div class="card"><div class="card-value cost-value">' + fmtCost(aggCost) + '</div><div class="card-label">Est. Cost</div></div>';
  html += '<div class="card"><div class="card-value">' + fmtDur(aggActive) + '</div><div class="card-label">Active Time</div></div>';
  html += '<div class="card"><div class="card-value">' + fmtDur(aggWall) + '</div><div class="card-label">Wall Clock</div></div>';
  html += '</div>';

  // Charts row 1: tokens + cost by model
  html += '<div class="charts-row"><div class="chart-box"><h3>Token Distribution</h3>';
  html += '<div class="stacked-bar">';
  tokParts.forEach(p => {
    html += '<div class="stacked-seg" style="width:' + (p.value / (aggTok || 1) * 100) + '%;background:' + p.color + '" title="' + p.label + ': ' + fmtTok(p.value) + '"></div>';
  });
  html += '</div><div class="legend">';
  tokParts.forEach(p => {
    html += '<span class="legend-item"><span class="legend-dot" style="background:' + p.color + '"></span>' + p.label + ': ' + fmtTok(p.value) + '</span>';
  });
  html += '</div></div>';

  html += '<div class="chart-box"><h3>Cost by Model</h3><div class="chart-scroll">';
  modelCosts.forEach(({ model, cost }) => {
    html += '<div class="bar-row"><span class="bar-label">' + escH(model) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (cost / maxMC * 100) + '%;background:#f97583"></div></div><span class="bar-value">' + fmtCost(cost) + '</span></div>';
  });
  html += '</div></div></div>';

  // Charts row 2: categories + tools
  html += '<div class="charts-row"><div class="chart-box"><h3>Task Categories</h3><div class="chart-scroll">';
  sortedCats.forEach(([cat, count]) => {
    html += '<div class="bar-row"><span class="bar-label">' + escH(cat) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (count / maxCat * 100) + '%;background:' + (CATEGORY_COLORS[cat] || '#6e7681') + '"></div></div><span class="bar-value">' + count + '</span></div>';
  });
  html += '</div></div><div class="chart-box"><h3>Top Tools</h3><div class="chart-scroll">';
  sortedTools.slice(0, 12).forEach(([name, count]) => {
    html += '<div class="bar-row"><span class="bar-label">' + escH(name) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (count / maxTool * 100) + '%;background:#58a6ff"></div></div><span class="bar-value">' + count + '</span></div>';
  });
  html += '</div></div></div>';

  // Charts row 3: cost by category + cost by date
  const costByCat = {};
  const costByDt = {};
  filtered.forEach(m => {
    const dk = m.created ? m.created.slice(0, 10) : 'unknown';
    costByDt[dk] = (costByDt[dk] || 0) + m.cost;
    m.tasks.forEach(t => { costByCat[t.category] = (costByCat[t.category] || 0) + t.cost; });
  });
  const sCostByCat = Object.entries(costByCat).sort((a, b) => b[1] - a[1]);
  const maxCBC = sCostByCat.length > 0 ? sCostByCat[0][1] : 1;
  const sCostByDt = Object.entries(costByDt).sort((a, b) => b[0].localeCompare(a[0]));
  const maxCBD = sCostByDt.length > 0 ? Math.max(...sCostByDt.map(e => e[1])) : 1;

  html += '<div class="charts-row"><div class="chart-box"><h3>Cost by Category</h3><div class="chart-scroll">';
  sCostByCat.forEach(([cat, cost]) => {
    html += '<div class="bar-row"><span class="bar-label">' + escH(cat) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (cost / maxCBC * 100) + '%;background:' + (CATEGORY_COLORS[cat] || '#6e7681') + '"></div></div><span class="bar-value">' + fmtCost(cost) + '</span></div>';
  });
  html += '</div></div><div class="chart-box"><h3>Cost by Date</h3><div class="chart-scroll">';
  sCostByDt.forEach(([date, cost]) => {
    html += '<div class="bar-row"><span class="bar-label">' + escH(date) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (cost / maxCBD * 100) + '%;background:#f97583"></div></div><span class="bar-value">' + fmtCost(cost) + '</span></div>';
  });
  html += '</div></div></div></div>';

  // Sessions list within this filter
  html += '<h2 style="margin-bottom:12px">Sessions (' + n + ')</h2>';
  html += '<table class="tasks-table"><thead><tr><th>Summary</th><th>Branch</th><th>Created</th><th>Active</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>';
  filtered.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()).forEach(m => {
    html += '<tr class="session-row" style="cursor:pointer" data-sid="' + escH(m.sessionId) + '">';
    html += '<td>' + escH(m.summary) + '</td>';
    html += '<td>' + escH(m.gitBranch || '—') + '</td>';
    html += '<td>' + (m.created ? m.created.slice(0, 10) : '—') + '</td>';
    html += '<td>' + fmtDur(m.activeTimeMs) + '</td>';
    html += '<td>' + fmtTok(totalTok(m)) + '</td>';
    html += '<td>' + fmtCost(m.cost) + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';

  const container = document.getElementById('aggregate-content');
  container.innerHTML = html;
  // Attach click handlers for session rows in aggregate view
  container.querySelectorAll('tr[data-sid]').forEach(row => {
    row.addEventListener('click', () => showSession(row.dataset.sid));
  });
}

// Navigation history
const navHistory = ['dashboard'];
let navIndex = 0;

function updateNavButtons() {
  document.getElementById('nav-back').disabled = navIndex <= 0;
  document.getElementById('nav-forward').disabled = navIndex >= navHistory.length - 1;
}

function navigateTo(view, addToHistory) {
  if (addToHistory !== false) {
    navHistory.splice(navIndex + 1);
    navHistory.push(view);
    navIndex = navHistory.length - 1;
  }
  updateNavButtons();

  const title = document.getElementById('breadcrumb-title');
  const crumbDash = document.getElementById('crumb-dashboard');
  const crumbSep = document.getElementById('crumb-sep');
  const dashView = document.getElementById('dashboard-view');
  const sessView = document.getElementById('session-viewer');
  const aggView = document.getElementById('aggregate-viewer');

  // Hide all views
  dashView.style.display = 'none';
  sessView.style.display = 'none';
  aggView.style.display = 'none';

  if (view === 'dashboard') {
    dashView.style.display = 'block';
    crumbDash.className = 'crumb-current';
    crumbDash.onclick = null;
    crumbDash.style.cursor = 'default';
    crumbSep.style.display = 'none';
    title.style.display = 'none';
  } else if (typeof view === 'object' && view.type) {
    // Aggregate view: { type: 'branch'|'date'|'category', value: '...' }
    const filtered = ALL_SESSIONS.filter(m => {
      if (view.type === 'branch') return m.gitBranch === view.value;
      if (view.type === 'date') return m.created && m.created.slice(0, 10) === view.value;
      if (view.type === 'category') {
        if (m.tasks.length === 0) return false;
        const cats = {};
        m.tasks.forEach(t => { cats[t.category] = (cats[t.category] || 0) + 1; });
        const top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0][0];
        return top === view.value;
      }
      return false;
    });
    renderAggregateView(view.type, view.value, filtered);
    aggView.style.display = 'block';
    crumbDash.className = 'crumb-link';
    crumbDash.onclick = hideSession;
    crumbDash.style.cursor = 'pointer';
    crumbSep.style.display = '';
    title.style.display = '';
    const lbl = view.type === 'branch' ? 'Branch' : view.type === 'date' ? 'Date' : 'Category';
    title.textContent = lbl + ': ' + view.value;
  } else {
    // Session detail view
    sessView.style.display = 'block';
    document.querySelectorAll('.session-detail').forEach(el => el.style.display = 'none');
    const panel = document.getElementById('session-' + view);
    if (panel) panel.style.display = 'block';
    crumbDash.className = 'crumb-link';
    crumbDash.onclick = hideSession;
    crumbDash.style.cursor = 'pointer';
    crumbSep.style.display = '';
    title.style.display = '';
    title.textContent = SESSION_TITLES[view] || view.slice(0, 8);
  }
  window.scrollTo(0, 0);
}

function showSession(id) {
  navigateTo(id);
}

function showAggregate(type, value) {
  if (!value || value === '—') return;
  navigateTo({ type, value });
}

function hideSession() {
  navigateTo('dashboard');
}

function navBack() {
  if (navIndex > 0) {
    navIndex--;
    navigateTo(navHistory[navIndex], false);
  }
}

function navForward() {
  if (navIndex < navHistory.length - 1) {
    navIndex++;
    navigateTo(navHistory[navIndex], false);
  }
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navBack(); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navForward(); }
  if (e.key === 'Escape') { hideSession(); }
});

// Cell click handler for sessions table
document.querySelector('#sessions-table tbody').addEventListener('click', (e) => {
  const td = e.target.closest('td[data-click]');
  if (!td) return;
  const action = td.dataset.click;
  if (action === 'session') {
    showSession(td.dataset.id);
  } else if (action === 'branch' || action === 'date' || action === 'category') {
    showAggregate(action, td.dataset.value);
  }
});

// Table sorting
document.querySelectorAll('.sessions-table th').forEach(th => {
  th.addEventListener('click', (e) => {
    e.stopPropagation();
    const table = th.closest('table');
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const col = parseInt(th.dataset.col);
    const isAsc = th.classList.contains('sorted-asc');

    table.querySelectorAll('th').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
    th.classList.add(isAsc ? 'sorted-desc' : 'sorted-asc');

    rows.sort((a, b) => {
      const aCell = a.cells[col];
      const bCell = b.cells[col];
      const aVal = aCell.dataset.sort || aCell.textContent.trim();
      const bVal = bCell.dataset.sort || bCell.textContent.trim();
      const aNum = parseFloat(aVal);
      const bNum = parseFloat(bVal);
      const cmp = (!isNaN(aNum) && !isNaN(bNum)) ? aNum - bNum : aVal.localeCompare(bVal);
      return isAsc ? -cmp : cmp;
    });
    rows.forEach(r => tbody.appendChild(r));
  });
});

// Initial sort: Created column descending
(function() {
  const th = document.querySelector('.sessions-table th[data-col="2"]');
  if (th) th.click(); // asc
  if (th) th.click(); // desc
})();

// Column resizing
(function() {
  const table = document.getElementById('sessions-table');
  if (!table) return;
  const ths = table.querySelectorAll('thead th');

  // Set initial widths from computed values so table-layout:fixed works after resize
  ths.forEach(th => {
    th.style.width = th.offsetWidth + 'px';
  });

  let didResize = false;

  ths.forEach(th => {
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);

    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.pageX;
      startWidth = th.offsetWidth;
      didResize = false;
      handle.classList.add('active');
      document.body.classList.add('col-resizing');

      function onMouseMove(ev) {
        didResize = true;
        const diff = ev.pageX - startX;
        const newWidth = Math.max(40, startWidth + diff);
        th.style.width = newWidth + 'px';
      }

      function onMouseUp() {
        handle.classList.remove('active');
        document.body.classList.remove('col-resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        // Suppress the click that follows mouseup on the th
        if (didResize) {
          th.addEventListener('click', function suppress(ev) {
            ev.stopImmediatePropagation();
            th.removeEventListener('click', suppress, true);
          }, true);
        }
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
})();
</script>
</body>
</html>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  migrateConfigDir();
  const args = parseArgs(process.argv);
  const projectDir = getProjectDir();
  const stateFilePath = getStateFilePath();
  const index = loadSessionIndex(projectDir);
  const state = args.full
    ? ({ version: 1, sessions: {} } as ParsedState)
    : loadState(stateFilePath);

  if (args.list) {
    let entries = index;
    if (args.branch) {
      entries = entries.filter((e) => e.gitBranch === args.branch);
    }
    if (args.session) {
      entries = entries.filter((e) => e.sessionId.startsWith(args.session!));
    }
    if (args.json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      printSessionList(entries);
    }
    return;
  }

  let entries = index;
  if (args.session) {
    entries = index.filter((e) => e.sessionId.startsWith(args.session!));
    if (entries.length === 0) {
      console.error(`No session found matching: ${args.session}`);
      process.exit(1);
    }
  }
  if (args.branch) {
    entries = entries.filter((e) => e.gitBranch === args.branch);
  }

  let parsed = 0;
  let cached = 0;
  const allMetrics: SessionMetrics[] = [];

  for (const entry of entries) {
    const force = args.full || !!args.session;
    if (needsParsing(entry, state, force)) {
      if (!fs.existsSync(entry.fullPath)) {
        console.error(`Warning: session file not found: ${entry.fullPath}`);
        continue;
      }
      const metrics = parseSession(entry.fullPath);
      metrics.sessionId = entry.sessionId;
      metrics.gitBranch = entry.gitBranch;
      metrics.firstPrompt = entry.firstPrompt;
      metrics.summary = entry.summary;
      metrics.created = entry.created;
      metrics.modified = entry.modified;

      state.sessions[entry.sessionId] = {
        fileMtime: entry.fileMtime ?? Date.now(),
        parsedAt: new Date().toISOString(),
        metrics,
      };
      parsed++;
    } else {
      cached++;
    }

    const metricsEntry = state.sessions[entry.sessionId]?.metrics;
    if (metricsEntry) {
      allMetrics.push(metricsEntry);
    }
  }

  // Save state (skip for single-session ad-hoc queries)
  if (!args.session) {
    saveState(stateFilePath, state);
  }

  // Output
  if (args.json) {
    console.log(JSON.stringify(allMetrics, null, 2));
  } else if (args.text) {
    for (const m of allMetrics) {
      printSessionMetrics(m);
      console.log();
    }
    console.log(
      `Done. Parsed: ${parsed}, Cached: ${cached}, Total: ${entries.length}`,
    );
  } else {
    // HTML (default)
    const html = generateHtmlReport(allMetrics);
    const outPath =
      args.out ?? path.join(os.tmpdir(), "claude-metrics-report.html");
    fs.writeFileSync(outPath, html);
    console.log(`Report written to ${outPath}`);
    console.log(
      `Parsed: ${parsed}, Cached: ${cached}, Total: ${entries.length}`,
    );
    try {
      execSync(`open "${outPath}"`);
    } catch {
      // Non-macOS or open command not available
    }
  }
}

// CLI entry point — only runs when invoked directly
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("session-metrics.ts")
) {
  main();
}
