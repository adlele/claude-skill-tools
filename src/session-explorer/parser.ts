// session-explorer/parser.ts — Deep JSONL parser for a single Claude session.
// Produces a SessionAnalysis with full timeline and metrics.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// die() is not used here — findSessionFile throws, and the caller
// (index.ts for CLI, server.ts for HTTP) handles the error appropriately.
import { normalizeModelName, computeCost } from "../metrics/session-metrics.js";
import {
  summarizeUserMessage,
  summarizeAssistantText,
  summarizeToolUse,
  summarizeToolResult,
  summarizeThinking,
} from "./summary.js";
import type {
  RawLogEntry,
  ContentBlock,
  ContentBlockResult,
  TokenUsage,
  ModelTokens,
  TaskCategory,
  TaskMetrics,
  TimelineEvent,
  TimelineContent,
  SubagentInfo,
  SessionAnalysis,
} from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_RESULT_LINES = 50;

// ─── Helpers (replicated from session-metrics.ts — not exported there) ──────

function extractTokens(entry: RawLogEntry): TokenUsage {
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
        toolName = classifyBashCommand(String(block.input.command));
      }
      calls[toolName] = (calls[toolName] ?? 0) + 1;
    }
  }
  return calls;
}

function isHumanPrompt(entry: RawLogEntry): boolean {
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

function mergeToolCalls(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [tool, count] of Object.entries(source)) {
    target[tool] = (target[tool] ?? 0) + count;
  }
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

function zeroTokens(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function addTokens(target: TokenUsage, source: TokenUsage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheReadTokens += source.cacheReadTokens;
}

// ─── JSONL reading ──────────────────────────────────────────────────────────

function readJsonl(filePath: string): RawLogEntry[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const entries: RawLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// ─── Session file discovery ─────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Pick the "main" conversation file from a session's subagents directory.
 * Heuristic: largest non-prompt-suggestion .jsonl file (most conversation data).
 */
function pickMainSubagentFile(sessionDir: string): string | null {
  const subDir = path.join(sessionDir, "subagents");
  if (!fs.existsSync(subDir)) return null;

  let bestFile: string | null = null;
  let bestSize = -1;

  try {
    for (const f of fs.readdirSync(subDir)) {
      if (!f.endsWith(".jsonl")) continue;
      // Skip prompt suggestions — they're lightweight background agents
      if (f.includes("prompt_suggestion")) continue;
      const full = path.join(subDir, f);
      try {
        const size = fs.statSync(full).size;
        if (size > bestSize) {
          bestSize = size;
          bestFile = full;
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  // Fall back to any .jsonl if all are prompt suggestions
  if (!bestFile) {
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const full = path.join(subDir, f);
        try {
          const size = fs.statSync(full).size;
          if (size > bestSize) {
            bestSize = size;
            bestFile = full;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return bestFile;
}

/**
 * Extract project path from a JSONL file's entries, falling back to decoding
 * from the project directory name.
 */
function extractProjectPath(filePath: string, projectDir: string): string {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    for (let i = 0; i < Math.min(lines.length, 50); i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.cwd) return entry.cwd;
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  // Fallback: decode from directory name
  const dirName = path.basename(projectDir);
  return dirName.startsWith("-")
    ? dirName.slice(1).replace(/-/g, "/")
    : dirName;
}

export interface SessionFileInfo {
  mainFile: string;
  sessionDir: string;
  projectPath: string;
  sessionId: string;
}

export function findSessionFile(sessionIdPrefix: string): SessionFileInfo {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) {
    throw new Error(
      "No Claude projects directory found at ~/.claude/projects/",
    );
  }

  const projectDirs = fs
    .readdirSync(projectsDir)
    .filter((d) => {
      const full = path.join(projectsDir, d);
      return fs.statSync(full).isDirectory();
    })
    .map((d) => path.join(projectsDir, d));

  interface Match {
    mainFile: string;
    sessionId: string;
    projectDir: string;
    mtime: number;
  }

  const matches: Match[] = [];

  for (const projectDir of projectDirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(projectDir);
    } catch {
      continue;
    }

    // Legacy format: <sessionId>.jsonl directly in project dir
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const sid = path.basename(f, ".jsonl");
      if (sid.startsWith(sessionIdPrefix)) {
        const full = path.join(projectDir, f);
        try {
          const stat = fs.statSync(full);
          matches.push({
            mainFile: full,
            sessionId: sid,
            projectDir,
            mtime: stat.mtimeMs,
          });
        } catch { /* skip */ }
      }
    }

    // New format: UUID-named session directories with subagents/
    for (const d of entries) {
      if (!UUID_RE.test(d)) continue;
      if (!d.startsWith(sessionIdPrefix)) continue;
      const sessionDir = path.join(projectDir, d);
      try {
        if (!fs.statSync(sessionDir).isDirectory()) continue;
      } catch { continue; }

      const mainFile = pickMainSubagentFile(sessionDir);
      if (!mainFile) continue;

      try {
        const stat = fs.statSync(mainFile);
        matches.push({
          mainFile,
          sessionId: d,
          projectDir,
          mtime: stat.mtimeMs,
        });
      } catch { /* skip */ }
    }
  }

  if (matches.length === 0) {
    throw new Error(`No session found matching prefix "${sessionIdPrefix}"`);
  }

  // Pick most recent if multiple matches
  matches.sort((a, b) => b.mtime - a.mtime);
  const best = matches[0];

  // Determine the session subdir (for subagents)
  const sessionDir = UUID_RE.test(path.basename(path.dirname(path.dirname(best.mainFile))))
    ? path.join(best.projectDir, best.sessionId) // new format: sessionDir is the UUID dir
    : path.join(best.projectDir, best.sessionId); // legacy: sessionDir may or may not exist

  const projectPath = extractProjectPath(best.mainFile, best.projectDir);

  return {
    mainFile: best.mainFile,
    sessionDir,
    projectPath,
    sessionId: best.sessionId,
  };
}

// ─── List all sessions (lightweight scan) ───────────────────────────────────

export interface SessionListEntry {
  sessionId: string;
  projectPath: string;
  gitBranch: string;
  slug: string;
  customTitle?: string;
  created: string;
  modified: string;
  firstPrompt: string;
  messageCount: number;
}

function peekSession(filePath: string): {
  gitBranch: string;
  slug: string;
  customTitle?: string;
  cwd: string;
  created: string;
  firstPrompt: string;
  messageCount: number;
} {
  let gitBranch = "";
  let slug = "";
  let customTitle: string | undefined;
  let cwd = "";
  let created = "";
  let firstPrompt = "";
  let messageCount = 0;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as RawLogEntry;
        if (!created && entry.timestamp) created = entry.timestamp;
        if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch;
        if (!slug && entry.slug) slug = entry.slug;
        if (!cwd && entry.cwd) cwd = entry.cwd;
        if (entry.type === "custom-title" && entry.customTitle)
          customTitle = entry.customTitle;
        if (entry.type === "user" || entry.type === "assistant") messageCount++;
        if (
          !firstPrompt &&
          entry.type === "user" &&
          !entry.isMeta &&
          typeof entry.message?.content === "string"
        ) {
          const c = entry.message.content;
          if (
            c.trim() &&
            !c.startsWith("<command-name>") &&
            !c.startsWith("<local-command") &&
            !c.startsWith("<task-notification>") &&
            !c.startsWith("<system-reminder>")
          ) {
            firstPrompt = c
              .replace(/<[^>]+>/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 200);
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }

  return {
    gitBranch,
    slug,
    customTitle,
    cwd,
    created,
    firstPrompt,
    messageCount,
  };
}

export function listAllSessions(): SessionListEntry[] {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];

  const projectDirs = fs
    .readdirSync(projectsDir)
    .filter((d) => {
      try {
        return fs.statSync(path.join(projectsDir, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((d) => path.join(projectsDir, d));

  const sessions: SessionListEntry[] = [];

  for (const projectDir of projectDirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(projectDir);
    } catch {
      continue;
    }

    // Legacy format: <sessionId>.jsonl directly in project dir
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const sessionId = path.basename(f, ".jsonl");
      const fullPath = path.join(projectDir, f);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const peek = peekSession(fullPath);

      let projectPath = peek.cwd;
      if (!projectPath) {
        const dirName = path.basename(projectDir);
        projectPath = dirName.startsWith("-")
          ? dirName.slice(1).replace(/-/g, "/")
          : dirName;
      }

      sessions.push({
        sessionId,
        projectPath,
        gitBranch: peek.gitBranch,
        slug: peek.slug,
        customTitle: peek.customTitle,
        created: peek.created || stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        firstPrompt: peek.firstPrompt,
        messageCount: peek.messageCount,
      });
    }

    // New format: UUID-named session directories with subagents/
    for (const d of entries) {
      if (!UUID_RE.test(d)) continue;
      const sessionDir = path.join(projectDir, d);
      try {
        if (!fs.statSync(sessionDir).isDirectory()) continue;
      } catch { continue; }

      const mainFile = pickMainSubagentFile(sessionDir);
      if (!mainFile) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(mainFile);
      } catch {
        continue;
      }

      const peek = peekSession(mainFile);

      let projectPath = peek.cwd;
      if (!projectPath) {
        const dirName = path.basename(projectDir);
        projectPath = dirName.startsWith("-")
          ? dirName.slice(1).replace(/-/g, "/")
          : dirName;
      }

      sessions.push({
        sessionId: d,
        projectPath,
        gitBranch: peek.gitBranch,
        slug: peek.slug,
        customTitle: peek.customTitle,
        created: peek.created || stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        firstPrompt: peek.firstPrompt,
        messageCount: peek.messageCount,
      });
    }
  }

  // Sort by modified descending (most recent first)
  sessions.sort(
    (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
  );

  return sessions;
}

// ─── Tool result text extraction ────────────────────────────────────────────

function extractToolResultText(
  content: string | ContentBlockResult[] | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => c.text ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// ─── Timeline building ─────────────────────────────────────────────────────

interface TimelineBuildContext {
  events: TimelineEvent[];
  fullResults: Record<string, string>;
  toolUseMap: Map<string, { name: string; input: Record<string, unknown> }>;
  nextId: number;
  agentId?: string;
  agentType?: string;
}

function makeId(ctx: TimelineBuildContext): string {
  return `evt-${ctx.nextId++}`;
}

function buildToolUseMap(
  entries: RawLogEntry[],
  map: Map<string, { name: string; input: Record<string, unknown> }>,
): void {
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as ContentBlock[]) {
      if (block.type === "tool_use" && block.id && block.name) {
        map.set(block.id, {
          name: block.name,
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
  }
}

function processEntriesToTimeline(
  entries: RawLogEntry[],
  ctx: TimelineBuildContext,
): void {
  for (const entry of entries) {
    const ts = entry.timestamp ?? "";

    if (entry.type === "user") {
      const content = entry.message?.content;

      if (typeof content === "string") {
        // Skip meta / system messages
        if (entry.isMeta) continue;
        if (content.startsWith("<command-name>")) continue;
        if (content.startsWith("<local-command")) continue;
        if (content.startsWith("<task-notification>")) continue;
        if (content.startsWith("<system-reminder>")) continue;
        if (!content.trim()) continue;

        ctx.events.push({
          id: entry.uuid ?? makeId(ctx),
          timestamp: ts,
          eventType: "user",
          summary: summarizeUserMessage(content),
          agentId: ctx.agentId,
          agentType: ctx.agentType,
          content: { kind: "user-text", text: content },
        });
      } else if (Array.isArray(content)) {
        // Tool results
        for (const block of content as ContentBlock[]) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const toolInfo = ctx.toolUseMap.get(block.tool_use_id);
            const toolName = toolInfo?.name ?? "unknown";
            const rawOutput = extractToolResultText(block.content);
            const isError = block.is_error === true;

            const evtId = makeId(ctx);
            const lines = rawOutput.split("\n");
            let output = rawOutput;
            let truncated = false;
            const fullLength = lines.length;

            if (lines.length > MAX_RESULT_LINES) {
              ctx.fullResults[evtId] = rawOutput;
              output = lines.slice(0, MAX_RESULT_LINES).join("\n");
              truncated = true;
            }

            ctx.events.push({
              id: evtId,
              timestamp: ts,
              eventType: "tool-result",
              summary: summarizeToolResult(toolName, rawOutput, isError),
              agentId: ctx.agentId,
              agentType: ctx.agentType,
              content: {
                kind: "tool-result",
                toolName,
                toolId: block.tool_use_id,
                output,
                isError,
                truncated,
                fullLength,
              },
            });
          }
        }
      }
    } else if (entry.type === "assistant") {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;

      const model = entry.message?.model;

      for (const block of content as ContentBlock[]) {
        if (block.type === "thinking" && block.thinking) {
          ctx.events.push({
            id: entry.uuid ? `${entry.uuid}-think` : makeId(ctx),
            timestamp: ts,
            eventType: "thinking",
            summary: summarizeThinking(block.thinking),
            agentId: ctx.agentId,
            agentType: ctx.agentType,
            content: { kind: "thinking", text: block.thinking },
          });
        } else if (block.type === "text" && block.text?.trim()) {
          ctx.events.push({
            id: entry.uuid ? `${entry.uuid}-text` : makeId(ctx),
            timestamp: ts,
            eventType: "assistant-text",
            summary: summarizeAssistantText(block.text),
            agentId: ctx.agentId,
            agentType: ctx.agentType,
            content: {
              kind: "assistant-text",
              text: block.text,
              model: model ?? undefined,
            },
          });
        } else if (block.type === "tool_use" && block.name) {
          const input = (block.input as Record<string, unknown>) ?? {};
          ctx.events.push({
            id: block.id ?? makeId(ctx),
            timestamp: ts,
            eventType: "tool-use",
            summary: summarizeToolUse(block.name, input),
            agentId: ctx.agentId,
            agentType: ctx.agentType,
            content: {
              kind: "tool-use",
              toolName: block.name,
              toolId: block.id ?? "",
              input,
            },
          });
        }
      }
    }
    // Skip progress, file-history-snapshot, queue-operation, etc.
  }
}

// ─── Task building ──────────────────────────────────────────────────────────

interface TaskAccumulator {
  description: string;
  startTime: string;
  endTime: string;
  tokens: TokenUsage;
  toolCalls: Record<string, number>;
  assistantTurns: number;
  modelTokens: ModelTokens;
}

function buildTasks(entries: RawLogEntry[]): TaskMetrics[] {
  const messages = entries.filter(
    (e) => e.type === "user" || e.type === "assistant",
  );

  const tasks: TaskAccumulator[] = [];
  let current: TaskAccumulator | null = null;

  for (const msg of messages) {
    if (isHumanPrompt(msg)) {
      const content = msg.message?.content as string;
      current = {
        description: content.slice(0, 120),
        startTime: msg.timestamp ?? "",
        endTime: msg.timestamp ?? "",
        tokens: zeroTokens(),
        toolCalls: {},
        assistantTurns: 0,
        modelTokens: {},
      };
      tasks.push(current);
    } else if (msg.type === "assistant" && current) {
      const tokens = extractTokens(msg);
      addTokens(current.tokens, tokens);
      current.assistantTurns++;
      current.endTime = msg.timestamp ?? current.endTime;

      const model = normalizeModelName(msg.message?.model ?? "");
      mergeModelTokens(current.modelTokens, { [model]: tokens });

      if (Array.isArray(msg.message?.content)) {
        mergeToolCalls(
          current.toolCalls,
          extractToolCalls(msg.message!.content as ContentBlock[]),
        );
      }
    } else if (msg.type === "assistant" && !current) {
      current = {
        description: "(system-initiated)",
        startTime: msg.timestamp ?? "",
        endTime: msg.timestamp ?? "",
        tokens: zeroTokens(),
        toolCalls: {},
        assistantTurns: 0,
        modelTokens: {},
      };
      tasks.push(current);

      const tokens = extractTokens(msg);
      addTokens(current.tokens, tokens);
      current.assistantTurns++;

      const model = normalizeModelName(msg.message?.model ?? "");
      mergeModelTokens(current.modelTokens, { [model]: tokens });

      if (Array.isArray(msg.message?.content)) {
        mergeToolCalls(
          current.toolCalls,
          extractToolCalls(msg.message!.content as ContentBlock[]),
        );
      }
    } else if (
      msg.type === "user" &&
      Array.isArray(msg.message?.content) &&
      current
    ) {
      // Tool results continue the current task
      current.endTime = msg.timestamp ?? current.endTime;
    }
  }

  return tasks.map((t, i) => {
    const wallClockMs =
      t.startTime && t.endTime
        ? new Date(t.endTime).getTime() - new Date(t.startTime).getTime()
        : 0;
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
      cost: computeCost(t.modelTokens),
    };
  });
}

// ─── Subagent loading ───────────────────────────────────────────────────────

interface SubagentData {
  agentId: string;
  agentType: string;
  entries: RawLogEntry[];
}

function loadSubagents(sessionDir: string, excludeFile?: string): SubagentData[] {
  const subDir = path.join(sessionDir, "subagents");
  if (!fs.existsSync(subDir)) return [];

  const excludeBase = excludeFile ? path.basename(excludeFile) : "";
  const files = fs.readdirSync(subDir);
  const agentMap = new Map<string, SubagentData>();

  // Load meta files first
  for (const f of files) {
    if (!f.endsWith(".meta.json")) continue;
    const agentId = f.replace(/^agent-/, "").replace(/\.meta\.json$/, "");
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subDir, f), "utf-8"));
      agentMap.set(agentId, {
        agentId,
        agentType: meta.agentType ?? "unknown",
        entries: [],
      });
    } catch {
      /* skip */
    }
  }

  // Load JSONL files (skip the file used as mainFile to avoid double-processing)
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    if (f === excludeBase) continue;
    const agentId = f.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    if (!agentMap.has(agentId)) {
      agentMap.set(agentId, { agentId, agentType: "unknown", entries: [] });
    }
    const data = agentMap.get(agentId)!;
    data.entries = readJsonl(path.join(subDir, f));
  }

  return Array.from(agentMap.values()).filter((a) => a.entries.length > 0);
}

// ─── Main parser ────────────────────────────────────────────────────────────

export function parseSessionDeep(
  mainFile: string,
  sessionDir: string,
): SessionAnalysis {
  // Step 1: Read main JSONL
  const entries = readJsonl(mainFile);

  // Step 2: Extract metadata
  let gitBranch = "";
  let slug = "";
  let customTitle: string | undefined;
  let projectPath = "";

  for (const e of entries) {
    if (!gitBranch && e.gitBranch) gitBranch = e.gitBranch;
    if (!slug && e.slug) slug = e.slug;
    if (!projectPath && e.cwd) projectPath = e.cwd;
    if (e.type === "custom-title" && e.customTitle) customTitle = e.customTitle;
  }

  const sessionId = path.basename(mainFile, ".jsonl");

  // Step 3: Build tool use map (for resolving tool_result → tool name)
  const toolUseMap = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();
  buildToolUseMap(entries, toolUseMap);

  // Step 4: Build timeline from main session
  const ctx: TimelineBuildContext = {
    events: [],
    fullResults: {},
    toolUseMap,
    nextId: 0,
  };
  processEntriesToTimeline(entries, ctx);

  // Step 5: Load and process subagents (exclude mainFile to avoid double-counting)
  const subagentDataList = loadSubagents(sessionDir, mainFile);
  const subagentInfos: SubagentInfo[] = [];

  for (const sub of subagentDataList) {
    // Build tool use map for subagent
    buildToolUseMap(sub.entries, toolUseMap);

    const subCtx: TimelineBuildContext = {
      events: ctx.events,
      fullResults: ctx.fullResults,
      toolUseMap,
      nextId: ctx.nextId,
      agentId: sub.agentId,
      agentType: sub.agentType,
    };
    processEntriesToTimeline(sub.entries, subCtx);
    ctx.nextId = subCtx.nextId;

    // Compute subagent metrics
    const subTokens = zeroTokens();
    const subModelTokens: ModelTokens = {};
    const subToolCalls: Record<string, number> = {};
    let eventCount = 0;

    for (const entry of sub.entries) {
      if (entry.type === "assistant") {
        const tokens = extractTokens(entry);
        addTokens(subTokens, tokens);
        const model = normalizeModelName(entry.message?.model ?? "");
        mergeModelTokens(subModelTokens, { [model]: tokens });
        if (Array.isArray(entry.message?.content)) {
          mergeToolCalls(
            subToolCalls,
            extractToolCalls(entry.message!.content as ContentBlock[]),
          );
        }
        eventCount++;
      } else if (entry.type === "user") {
        eventCount++;
      }
    }

    subagentInfos.push({
      agentId: sub.agentId,
      agentType: sub.agentType,
      tokenUsage: subTokens,
      modelTokens: subModelTokens,
      cost: computeCost(subModelTokens),
      eventCount,
      toolCalls: subToolCalls,
    });
  }

  // Step 6: Sort all timeline events by timestamp
  ctx.events.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Step 7: Compute session-level metrics
  const tasks = buildTasks(entries);

  const sessionToolCalls: Record<string, number> = {};
  const sessionModelTokens: ModelTokens = {};
  const sessionTokens = zeroTokens();
  let totalAssistantTurns = 0;
  let activeTimeMs = 0;

  for (const t of tasks) {
    addTokens(sessionTokens, t);
    mergeToolCalls(sessionToolCalls, t.toolCalls);
    mergeModelTokens(sessionModelTokens, t.modelTokens);
    totalAssistantTurns += t.assistantTurns;
    activeTimeMs += t.wallClockMs;
  }

  // Wall clock: first to last message timestamp
  const timestamps = entries
    .map((e) => e.timestamp)
    .filter(Boolean)
    .map((t) => new Date(t!).getTime());
  const wallClockMs =
    timestamps.length >= 2
      ? Math.max(...timestamps) - Math.min(...timestamps)
      : 0;

  const created =
    timestamps.length > 0
      ? new Date(Math.min(...timestamps)).toISOString()
      : "";
  const modified =
    timestamps.length > 0
      ? new Date(Math.max(...timestamps)).toISOString()
      : "";

  // Count user turns (real human prompts)
  const userTurns = entries.filter((e) => isHumanPrompt(e)).length;

  return {
    sessionId,
    projectPath,
    gitBranch,
    slug,
    customTitle,
    created,
    modified,
    wallClockMs,
    activeTimeMs,
    userTurns,
    assistantTurns: totalAssistantTurns,
    totalTokens: sessionTokens,
    modelTokens: sessionModelTokens,
    cost: computeCost(sessionModelTokens),
    toolCalls: sessionToolCalls,
    tasks,
    subagents: subagentInfos,
    timeline: ctx.events,
    fullResults: ctx.fullResults,
  };
}
