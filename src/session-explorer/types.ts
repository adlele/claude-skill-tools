// session-explorer/types.ts — All type definitions for the session explorer.

// ─── Raw JSONL types ────────────────────────────────────────────────────────

export interface RawLogEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  version?: string;
  gitBranch?: string;
  slug?: string;
  cwd?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  userType?: string;
  requestId?: string;
  agentId?: string;
  permissionMode?: string;
  customTitle?: string;
  agentName?: string;
  subtype?: string;
  durationMs?: number;

  message?: {
    role?: string;
    model?: string;
    id?: string;
    content?: string | ContentBlock[];
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlockResult[];
  is_error?: boolean;
  caller?: { type: string };
}

export interface ContentBlockResult {
  type: string;
  text?: string;
}

// ─── Token / Cost types ─────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export type ModelTokens = Record<string, TokenUsage>;

// ─── Task types ─────────────────────────────────────────────────────────────

export type TaskCategory =
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

// ─── Timeline types ─────────────────────────────────────────────────────────

export type TimelineEventType =
  | "user"
  | "assistant-text"
  | "tool-use"
  | "tool-result"
  | "thinking"
  | "system";

export interface TimelineEvent {
  id: string;
  timestamp: string;
  eventType: TimelineEventType;
  summary: string;
  agentId?: string;
  agentType?: string;
  content: TimelineContent;
}

export type TimelineContent =
  | { kind: "user-text"; text: string }
  | { kind: "assistant-text"; text: string; model?: string }
  | {
      kind: "tool-use";
      toolName: string;
      toolId: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "tool-result";
      toolName: string;
      toolId: string;
      output: string;
      isError: boolean;
      truncated: boolean;
      fullLength: number;
    }
  | { kind: "thinking"; text: string }
  | { kind: "system"; subtype: string; text: string };

// ─── Subagent types ─────────────────────────────────────────────────────────

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  tokenUsage: TokenUsage;
  modelTokens: ModelTokens;
  cost: number;
  eventCount: number;
  toolCalls: Record<string, number>;
}

// ─── Session list entry (lightweight, for sidebar) ──────────────────────────

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

// ─── Session analysis result ────────────────────────────────────────────────

export interface SessionAnalysis {
  sessionId: string;
  projectPath: string;
  gitBranch: string;
  slug: string;
  customTitle?: string;
  created: string;
  modified: string;
  wallClockMs: number;
  activeTimeMs: number;
  userTurns: number;
  assistantTurns: number;
  totalTokens: TokenUsage;
  modelTokens: ModelTokens;
  cost: number;
  toolCalls: Record<string, number>;
  tasks: TaskMetrics[];
  subagents: SubagentInfo[];
  timeline: TimelineEvent[];
  /** eventId → full output for tool results that were truncated in the timeline */
  fullResults: Record<string, string>;
}
